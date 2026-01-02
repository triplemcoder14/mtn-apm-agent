'use strict';


let diagch = null;
try {
  diagch = require('diagnostics_channel');
} catch (_importErr) {
  // pass
}

const semver = require('semver');

// Search an undici@5 request.headers string for a 'traceparent' header.
const headersStrHasTraceparentRe = /^traceparent:/im;

let isInstrumented = false;
let spanFromReq = null;
let chans = null;

// Get the content-length from undici response headers.
// `headers` is an Array of buffers: [k, v, k, v, ...].
// If the header is not present, or has an invalid value, this returns null.
function contentLengthFromResponseHeaders(headers) {
  const name = 'content-length';
  for (let i = 0; i < headers.length; i += 2) {
    const k = headers[i];
    if (k.length === name.length && k.toString().toLowerCase() === name) {
      const v = Number(headers[i + 1]);
      if (!isNaN(v)) {
        return v;
      } else {
        return null;
      }
    }
  }
  return null;
}

function uninstrumentUndici() {
  if (!isInstrumented) {
    return;
  }
  isInstrumented = false;

  spanFromReq = null;
  chans.forEach(({ chan, onMessage }) => {
    chan.unsubscribe(onMessage);
  });
  chans = null;
}

/**
 * Setup instrumentation for undici. The instrumentation is based entirely on
 * diagnostics_channel usage, so no reference to the loaded undici module is
 * required.
 */
function instrumentUndici(agent) {
  if (isInstrumented) {
    return;
  }
  isInstrumented = true;

  const ins = agent._instrumentation;
  spanFromReq = new WeakMap();


  // unsubscribing.
  chans = [];
  function diagchSub(name, onMessage) {
    const chan = diagch.channel(name);
    chan.subscribe(onMessage);
    chans.push({
      name,
      chan,
      onMessage,
    });
  }

  diagchSub('undici:request:create', ({ request }) => {
    // We do not handle instrumenting HTTP CONNECT. See limitation notes above.
    if (request.method === 'CONNECT') {
      return;
    }

    const url = new URL(request.origin);
    const span = ins.createSpan(
      `${request.method} ${url.host}`,
      'external',
      'http',
      request.method,
      { exitSpan: true },
    );

    // W3C trace-context propagation.
    // If the span is null (e.g. hit `transactionMaxSpans`, unsampled
    // transaction), then fallback to the current run context's span or
    // transaction, if any.
    const parentRunContext = ins.currRunContext();
    const propSpan =
      span || parentRunContext.currSpan() || parentRunContext.currTransaction();
    if (propSpan) {
      // Guard against adding a duplicate 'traceparent' header, because that
      // Dev Note: This cheats a little and assumes the header names to add
      // will include 'traceparent'.
      let alreadyHasTp = false;
      if (Array.isArray(request.headers)) {
        // undici@6
        for (let i = 0; i < request.headers.length; i += 2) {
          if (request.headers[i].toLowerCase() === 'traceparent') {
            alreadyHasTp = true;
            break;
          }
        }
      } else if (typeof request.headers === 'string') {
        // undici@5
        alreadyHasTp = headersStrHasTraceparentRe.test(request.headers);
      }

      if (!alreadyHasTp) {
        propSpan.propagateTraceContextHeaders(
          request,
          function (req, name, value) {
            if (typeof request.addHeader === 'function') {
              req.addHeader(name, value);
            } else if (Array.isArray(request.headers)) {
              // undici@6.11.0 accidentally, briefly removed `request.addHeader()`.
              req.headers.push(name, value);
            }
          },
        );
      }
    }

    if (span) {
      spanFromReq.set(request, span);

      // Set some initial HTTP context, in case the request errors out before a response.
      span.setHttpContext({
        method: request.method,
        url: request.origin + request.path,
      });

      const destContext = {
        address: url.hostname,
      };
      const port =
        Number(url.port) ||
        (url.protocol === 'https:' && 443) ||
        (url.protocol === 'http:' && 80);
      if (port) {
        destContext.port = port;
      }
      span._setDestinationContext(destContext);
    }
  });

  diagchSub('undici:request:headers', ({ request, response }) => {
    const span = spanFromReq.get(request);
    if (span !== undefined) {
      // We are currently *not* capturing response headers, even though the
      // intake API does allow it, because none of the other `setHttpContext`
      // uses currently do.

      const httpContext = {
        method: request.method,
        status_code: response.statusCode,
        url: request.origin + request.path,
      };
      const cLen = contentLengthFromResponseHeaders(response.headers);
      if (cLen !== null) {
        httpContext.response = { encoded_body_size: cLen };
      }
      span.setHttpContext(httpContext);

      span._setOutcomeFromHttpStatusCode(response.statusCode);
    }
  });

  diagchSub('undici:request:trailers', ({ request }) => {
    const span = spanFromReq.get(request);
    if (span !== undefined) {
      span.end();
      spanFromReq.delete(request);
    }
  });

  diagchSub('undici:request:error', ({ request, error }) => {
    const span = spanFromReq.get(request);
    const errOpts = {};
    if (span !== undefined) {
      errOpts.parent = span;
      // Cases where we won't have an undici parent span:
      // - We've hit transactionMaxSpans.
      // - The undici HTTP span was suppressed because it is a child of an
      //   exit span (e.g. when used as the transport for the Elasticsearch
      //   client).
      // It might be debatable whether we want to capture the error in the
      // latter case. This could be revisited later.
    }
    agent.captureError(error, errOpts);
    if (span !== undefined) {
      span.end();
      spanFromReq.delete(request);
    }
  });
}

function shimUndici(undici, agent, { version, enabled }) {
  if (!enabled) {
    return undici;
  }
  if (semver.lt(version, '4.7.1')) {
    // Undici added its diagnostics_channel messages in v4.7.0. In v4.7.1 the
    // `request.origin` property, that we need, was added.
    agent.logger.debug(
      'cannot instrument undici: undici version %s is not supported',
      version,
    );
    return undici;
  }
  if (!diagch) {
    agent.logger.debug(
      'cannot instrument undici: there is no "diagnostics_channel" module',
      process.version,
    );
    return undici;
  }

  instrumentUndici(agent);
  return undici;
}

module.exports = shimUndici;
module.exports.instrumentUndici = instrumentUndici;
module.exports.uninstrumentUndici = uninstrumentUndici;
