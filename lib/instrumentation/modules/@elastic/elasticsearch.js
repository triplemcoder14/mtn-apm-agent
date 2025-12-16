'use strict';


const semver = require('semver');
const { URL, URLSearchParams } = require('url');

const { getDBDestination } = require('../../context');
const { getElasticsearchDbStatement } = require('../../elasticsearch-shared');
const shimmer = require('../../shimmer');

/**
 *
 * @param {import("@elastic/elasticsearch").DiagnosticResult || null}
 * @returns { string || null }
 */
function getESClusterName(diagResult) {
  if (diagResult && diagResult.headers) {
    const clusterNameFromHeader =
      diagResult.headers['x-found-handling-cluster'];
    if (clusterNameFromHeader) {
      return clusterNameFromHeader;
    }
  }
}

module.exports = function (elasticsearch, agent, { version, enabled }) {
  if (!enabled) {
    return elasticsearch;
  }
  if (!elasticsearch.Client) {
    agent.logger.debug(
      '@elastic/elasticsearch@%s is not supported (no `elasticsearch.Client`) - aborting...',
      version,
    );
    return elasticsearch;
  }

  const doubleCallsRequestIfNoCb = semver.lt(version, '7.7.0');
  const ins = agent._instrumentation;
  const isGteV8 = semver.satisfies(version, '>=8', { includePrerelease: true });
  const elasticsearchCaptureBodyUrlsRegExp =
    agent._conf.elasticsearchCaptureBodyUrlsRegExp;

  agent.logger.debug(
    'shimming elasticsearch.Transport.prototype.{request,getConnection}',
  );
  shimmer.wrap(
    elasticsearch.Transport && elasticsearch.Transport.prototype,
    'request',
    wrapRequest,
  );
  shimmer.wrap(
    elasticsearch.Transport && elasticsearch.Transport.prototype,
    'getConnection',
    wrapGetConnection,
  );
  shimmer.wrap(elasticsearch, 'Client', wrapClient);

  const connFromSpan = new WeakMap();
  const diagResultFromSpan = new WeakMap();

  return elasticsearch;

  function wrapClient(OrigClient) {
    class ClientTraced extends OrigClient {
      constructor(...args) {
        super(...args);
        const diagnostic = isGteV8 ? this.diagnostic : this;
        diagnostic.on('response', (_err, result) => {
          if (result) {
            const currSpan = ins.currSpan();
            if (currSpan) {
              diagResultFromSpan.set(currSpan, result);
            }
          }
        });
      }
    }
    return ClientTraced;
  }

  function wrapGetConnection(origGetConnection) {
    return function wrappedGetConnection(opts) {
      const conn = origGetConnection.apply(this, arguments);
      const currSpan = ins.currSpan();
      if (conn && currSpan) {
        connFromSpan.set(currSpan, conn);
      }
      return conn;
    };
  }

  function wrapRequest(origRequest) {
    return function wrappedRequest(params, options, cb) {
      options = options || {};
      if (typeof options === 'function') {
        cb = options;
        options = {};
      }

      if (typeof cb !== 'function' && doubleCallsRequestIfNoCb) {
        return origRequest.apply(this, arguments);
      }

      const method = (params && params.method) || '<UnknownMethod>';
      const path = (params && params.path) || '<UnknownPath>';
      agent.logger.debug(
        { method, path },
        'intercepted call to @elastic/elasticsearch.Transport.prototype.request',
      );
      const span = ins.createSpan(
        `Elasticsearch: ${method} ${path}`,
        'db',
        'elasticsearch',
        'request',
        { exitSpan: true },
      );
      if (!span) {
        return origRequest.apply(this, arguments);
      }

      const parentRunContext = ins.currRunContext();
      const spanRunContext = parentRunContext.enterSpan(span);
      const finish = ins.bindFunctionToRunContext(
        spanRunContext,
        (err, result) => {
 
          let conn = connFromSpan.get(span);
          if (conn) {
            connFromSpan.delete(span);
          } else if (this.connectionPool && this.connectionPool.connections) {
            conn = this.connectionPool.connections[0];
          }
          const connUrl = conn && conn.url;
          span._setDestinationContext(
            getDBDestination(
              connUrl && connUrl.hostname,
              connUrl && connUrl.port,
            ),
          );

          const httpContext = {};
          let haveHttpContext = false;
          let diagResult = isGteV8 ? null : result;
          if (!diagResult) {
            diagResult = diagResultFromSpan.get(span);
            if (diagResult) {
              diagResultFromSpan.delete(span);
            }
          }
          if (diagResult) {
            if (diagResult.statusCode) {
              haveHttpContext = true;
              httpContext.status_code = diagResult.statusCode;
            }

            if (diagResult.headers && 'content-length' in diagResult.headers) {
              const contentLength = Number(
                diagResult.headers['content-length'],
              );
              if (!isNaN(contentLength)) {
                haveHttpContext = true;
                httpContext.response = { encoded_body_size: contentLength };
              }
            }
          }

          let origin;
          if (connUrl) {
            origin = connUrl.origin;
          } else if (
            diagResult &&
            diagResult.meta &&
            diagResult.meta.connection &&
            diagResult.meta.connection.url
          ) {
            try {
              origin = new URL(diagResult.meta.connection.url).origin;
            } catch (_ignoredErr) {}
          }
          if (origin && params && params.path) {
            const fullUrl = new URL(origin);
            fullUrl.pathname = params.path;
            fullUrl.search = new URLSearchParams(params.querystring).toString();
            httpContext.url = fullUrl.toString();
            haveHttpContext = true;
          }

          if (haveHttpContext) {
            span.setHttpContext(httpContext);
          }

          // Set DB context.
          const dbContext = {
            type: 'elasticsearch',
          };
          if (params) {
            const statement = getElasticsearchDbStatement(
              params.path,
              params.body || params.bulkBody,
              elasticsearchCaptureBodyUrlsRegExp,
            );
            if (statement) {
              dbContext.statement = statement;
            }
          }
          const clusterName = getESClusterName(diagResult);
          if (clusterName) {
            dbContext.instance = clusterName;
          }
          span.setDbContext(dbContext);

          if (err) {
            const errOpts = {
              captureAttributes: false,
            };
            const errBody = err.body;
            if (err.name === 'ResponseError' && errBody && errBody.error) {
              const errType = errBody.error.type;
              if (errType) {
                // Specialize `error.exception.type` for better error grouping.
                errOpts.exceptionType = `ResponseError (${errType})`;
              }
              errOpts.custom = {
                type: errType,
                reason: errBody.error.reason,
                status: errBody.status,
              };
              if (errBody.error.caused_by) {
                errOpts.custom.caused_by = errBody.error.caused_by;
              }
            }
            agent.captureError(err, errOpts);
          }

          span.end();
        },
      );

      if (typeof cb === 'function') {
        const wrappedCb = (err, result) => {
          finish(err, result);
          ins.withRunContext(parentRunContext, cb, this, err, result);
        };
        return ins.withRunContext(
          spanRunContext,
          origRequest,
          this,
          params,
          options,
          wrappedCb,
        );
      } else {
        const origPromise = ins.withRunContext(
          spanRunContext,
          origRequest,
          this,
          ...arguments,
        );
        origPromise.then(
          function onResolve(result) {
            finish(null, result);
          },
          function onReject(err) {
            finish(err, null);
          },
        );

        return origPromise;
      }
    };
  }
};
