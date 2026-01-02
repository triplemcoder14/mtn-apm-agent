'use strict';

const constants = require('./constants');
const shimmer = require('./instrumentation/shimmer');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const { MAX_MESSAGES_PROCESSED_FOR_TRACE_CONTEXT } = require('./constants');

let isFirstRun = true;
let gFaasId; // Set on first invocation.

const TRIGGER_GENERIC = 1;
const TRIGGER_API_GATEWAY = 2;
const TRIGGER_SNS = 3;
const TRIGGER_SQS = 4;
const TRIGGER_S3_SINGLE_EVENT = 5;
const TRIGGER_ELB = 6;

function triggerTypeFromEvent(event) {
  if (event.requestContext) {
    if (event.requestContext.elb) {
      return TRIGGER_ELB;
    } else if (event.requestContext.requestId) {
      return TRIGGER_API_GATEWAY;
    }
  }
  if (event.Records && event.Records.length >= 1) {
    const eventSource =
      event.Records[0].eventSource || // S3 and SQS
      event.Records[0].EventSource; // SNS
    if (eventSource === 'aws:sns') {
      return TRIGGER_SNS;
    } else if (eventSource === 'aws:sqs') {
      return TRIGGER_SQS;
    } else if (eventSource === 'aws:s3' && event.Records.length === 1) {
      return TRIGGER_S3_SINGLE_EVENT;
    }
  }
  return TRIGGER_GENERIC;
}

function getMetadata(agent, cloudAccountId) {
  return {
    service: {
      framework: {
        // Passing this service.framework.name to Client#setExtraMetadata()
        // ensures that it "wins" over a framework name from
        // `agent.setFramework()`, because in the client `_extraMetadata`
        // wins over `_conf.frameworkName`.
        name: 'AWS Lambda',
      },
      runtime: {
        name: process.env.AWS_EXECUTION_ENV,
      },
      node: {
        configured_name: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
      },
    },
    cloud: {
      provider: 'aws',
      region: process.env.AWS_REGION,
      service: {
        name: 'lambda',
      },
      account: {
        id: cloudAccountId,
      },
    },
  };
}

function getFaasData(context, faasId, isColdStart, faasTriggerType, requestId) {
  const faasData = {
    id: faasId,
    name: context.functionName,
    version: context.functionVersion,
    coldstart: isColdStart,
    execution: context.awsRequestId,
    trigger: {
      type: faasTriggerType,
    },
  };
  if (requestId) {
    faasData.trigger.request_id = requestId;
  }
  return faasData;
}

function setGenericData(trans, event, context, faasId, isColdStart) {
  trans.type = 'request';
  trans.setDefaultName(context.functionName);

  trans.setFaas(getFaasData(context, faasId, isColdStart, 'other'));

  const cloudContext = {
    origin: {
      provider: 'aws',
    },
  };
  trans.setCloudContext(cloudContext);
}

function setApiGatewayData(agent, trans, event, context, faasId, isColdStart) {
  const requestContext = event.requestContext;

  let name;
  let pseudoReq;
  if (requestContext.http) {
    // 2.0
    if (agent._conf.usePathAsTransactionName) {
      name = `${requestContext.http.method} ${requestContext.http.path}`;
    } else {
      let routeKeyPath = requestContext.routeKey;
      const spaceIdx = routeKeyPath.indexOf(' ');
      if (spaceIdx === -1) {
        routeKeyPath = '/' + routeKeyPath;
      } else {
        routeKeyPath = routeKeyPath.slice(spaceIdx + 1);
      }
      name = `${requestContext.http.method} /${requestContext.stage}${routeKeyPath}`;
    }
    pseudoReq = {
      httpVersion: requestContext.http.protocol
        ? requestContext.http.protocol.split('/')[1] // 'HTTP/1.1' -> '1.1'
        : undefined,
      method: requestContext.http.method,
      url:
        event.rawPath +
        (event.rawQueryString ? '?' + event.rawQueryString : ''),
      headers: event.normedHeaders || {},
      socket: { remoteAddress: requestContext.http.sourceIp },
      body: event.body,
    };
  } else {
    // payload version format 1.0
    if (agent._conf.usePathAsTransactionName) {
      name = `${requestContext.httpMethod} ${requestContext.path}`;
    } else {
      name = `${requestContext.httpMethod} /${requestContext.stage}${requestContext.resourcePath}`;
    }
    pseudoReq = {
      httpVersion: requestContext.protocol
        ? requestContext.protocol.split('/')[1] // 'HTTP/1.1' -> '1.1'
        : undefined,
      method: requestContext.httpMethod,
      url:
        requestContext.path +
        (event.queryStringParameters
          ? '?' + querystring.encode(event.queryStringParameters)
          : ''),
      headers: event.normedHeaders || {},
      socket: {
        remoteAddress:
          requestContext.identity && requestContext.identity.sourceIp,
      },

      body: event.body,
    };
  }
  trans.type = 'request';
  trans.setDefaultName(name);
  trans.req = pseudoReq; // Used by parsers.getContextFromRequest() for adding context to transaction and errors.

  trans.setFaas(
    getFaasData(context, faasId, isColdStart, 'http', requestContext.requestId),
  );

  const serviceContext = {
    origin: {
      name: requestContext.domainName,
      id: requestContext.apiId,
      version: event.version || '1.0',
    },
  };
  trans.setServiceContext(serviceContext);

  const originSvcName =
    requestContext.domainName &&
    requestContext.domainPrefix &&
    requestContext.domainName.startsWith(
      requestContext.domainPrefix + '.lambda-url.',
    )
      ? 'lambda url'
      : 'api gateway';
  const cloudContext = {
    origin: {
      provider: 'aws',
      service: {
        name: originSvcName,
      },
      account: {
        id: requestContext.accountId,
      },
    },
  };
  trans.setCloudContext(cloudContext);
}

function setTransDataFromApiGatewayResult(err, result, trans, event) {
  if (err) {
    trans.result = 'HTTP 5xx';
    trans._setOutcomeFromHttpStatusCode(500);
  } else if (result && result.statusCode) {
    trans.result = 'HTTP ' + result.statusCode.toString()[0] + 'xx';
    trans._setOutcomeFromHttpStatusCode(result.statusCode);
  } else {
    trans.result = constants.RESULT_SUCCESS;
    trans._setOutcomeFromHttpStatusCode(200);
  }

  if (err) {
    trans.res = {
      statusCode: 500,
    };
  } else if (event.requestContext.http) {
    // payload format version 2.0
    if (result && result.statusCode) {
      trans.res = {
        statusCode: result.statusCode,
        headers: result.headers,
      };
    } else {
      trans.res = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
      };
    }
  } else {
    // payload format version 1.0
    if (result && result.statusCode) {
      trans.res = {
        statusCode: result.statusCode,
        headers: result.headers,
      };
    }
  }
}

function setElbData(agent, trans, event, context, faasId, isColdStart) {
  trans.type = 'request';
  let name;
  if (agent._conf.usePathAsTransactionName) {
    name = `${event.httpMethod} ${event.path}`;
  } else {
    name = `${event.httpMethod} unknown route`;
  }
  trans.setDefaultName(name);
  trans.req = {
    method: event.httpMethod,
    url:
      event.path +
      (event.queryStringParameters &&
      Object.keys(event.queryStringParameters) > 0
        ? '?' + querystring.encode(event.queryStringParameters)
        : ''),
    headers: event.normedHeaders || {},
    body: event.body,
    bodyIsBase64Encoded: event.isBase64Encoded,
  };

  trans.setFaas(getFaasData(context, faasId, isColdStart, 'http'));

  const targetGroupArn = event.requestContext.elb.targetGroupArn;
  const arnParts = targetGroupArn.split(':');
  trans.setServiceContext({
    origin: {
      name: arnParts[5].split('/')[1],
      id: targetGroupArn,
    },
  });

  trans.setCloudContext({
    origin: {
      provider: 'aws',
      region: arnParts[3],
      service: {
        name: 'elb',
      },
      account: {
        id: arnParts[4],
      },
    },
  });
}

function setTransDataFromElbResult(err, result, trans) {
  const validStatusCode =
    result &&
    result.statusCode &&
    typeof result.statusCode === 'number' &&
    Number.isInteger(result.statusCode)
      ? result.statusCode
      : null;

  if (err) {
    trans.result = 'HTTP 5xx';
  } else if (validStatusCode) {
    trans.result = 'HTTP ' + validStatusCode.toString()[0] + 'xx';
  } else {
    trans.result = 'HTTP 5xx';
  }

  if (err) {
    trans.res = {
      statusCode: 502,
    };
  } else {
    trans.res = {
      statusCode: validStatusCode || 502,
      headers: result.headers,
    };
  }

  trans._setOutcomeFromHttpStatusCode(validStatusCode || 502);
}

function setSqsData(agent, trans, event, context, faasId, isColdStart) {
  const record = event && event.Records && event.Records[0];
  const eventSourceARN = record.eventSourceARN ? record.eventSourceARN : '';

  trans.setFaas(getFaasData(context, faasId, isColdStart, 'pubsub'));

  const arnParts = eventSourceARN.split(':');
  const queueName = arnParts[5];
  const accountId = arnParts[4];

  trans.setDefaultName(`RECEIVE ${queueName}`);
  trans.type = 'messaging';

  const serviceContext = {
    origin: {
      name: queueName,
      id: eventSourceARN,
    },
  };
  trans.setServiceContext(serviceContext);

  const cloudContext = {
    origin: {
      provider: 'aws',
      region: record.awsRegion,
      service: {
        name: 'sqs',
      },
      account: {
        id: accountId,
      },
    },
  };
  trans.setCloudContext(cloudContext);

  const links = spanLinksFromSqsRecords(event.Records);
  trans.addLinks(links);
}

function setSnsData(agent, trans, event, context, faasId, isColdStart) {
  const record = event && event.Records && event.Records[0];
  const sns = record && record.Sns;

  trans.setFaas(getFaasData(context, faasId, isColdStart, 'pubsub'));

  const topicArn = (sns && sns.TopicArn) || '';
  const arnParts = topicArn.split(':');
  const topicName = arnParts[5];
  const accountId = arnParts[4];
  const region = arnParts[3];

  trans.setDefaultName(`RECEIVE ${topicName}`);
  trans.type = 'messaging';

  const serviceContext = {
    origin: {
      name: topicName,
      id: topicArn,
    },
  };
  trans.setServiceContext(serviceContext);

  const cloudContext = {
    origin: {
      provider: 'aws',
      region,
      service: {
        name: 'sns',
      },
      account: {
        id: accountId,
      },
    },
  };
  trans.setCloudContext(cloudContext);

  const links = spanLinksFromSnsRecords(event.Records);
  trans.addLinks(links);
}

function setS3SingleData(trans, event, context, faasId, isColdStart) {
  const record = event.Records[0];

  trans.setFaas(
    getFaasData(
      context,
      faasId,
      isColdStart,
      'datasource',
      record.responseElements && record.responseElements['x-amz-request-id'],
    ),
  );

  trans.setDefaultName(
    `${record && record.eventName} ${
      record && record.s3 && record.s3.bucket && record.s3.bucket.name
    }`,
  );
  trans.type = 'request';

  const serviceContext = {
    origin: {
      name: record && record.s3 && record.s3.bucket && record.s3.bucket.name,
      id: record && record.s3 && record.s3.bucket && record.s3.bucket.arn,
      version: record.eventVersion,
    },
  };
  trans.setServiceContext(serviceContext);

  const cloudContext = {
    origin: {
      provider: 'aws',
      service: {
        name: 's3',
      },
      region: record.awsRegion,
    },
  };
  trans.setCloudContext(cloudContext);
}

function mtnApmAwsLambda(agent) {
  const log = agent.logger;
  const ins = agent._instrumentation;

  function registerTransaction(trans, awsRequestId) {
    if (!agent._apmClient) {
      return;
    }
    if (!agent._apmClient.lambdaShouldRegisterTransactions()) {
      return;
    }

    if (agent._conf.contextPropagationOnly) {
      return;
    }
    if (
      !trans.sampled &&
      !agent._apmClient.supportsKeepingUnsampledTransaction()
    ) {
      return;
    }

    var payload = trans.toJSON();
    delete payload.result;
    delete payload.duration;

    payload = agent._transactionFilters.process(payload);
    if (!payload) {
      log.trace(
        { traceId: trans.traceId, transactionId: trans.id },
        'transaction ignored by filter',
      );
      return;
    }

    return agent._apmClient.lambdaRegisterTransaction(payload, awsRequestId);
  }

  function endAndFlushTransaction(
    err,
    result,
    trans,
    event,
    context,
    triggerType,
    cb,
  ) {
    log.trace(
      { awsRequestId: context && context.awsRequestId },
      'lambda: fn end',
    );

    switch (triggerType) {
      case TRIGGER_API_GATEWAY:
        setTransDataFromApiGatewayResult(err, result, trans, event);
        break;
      case TRIGGER_ELB:
        setTransDataFromElbResult(err, result, trans);
        break;
      default:
        if (err) {
          trans.result = constants.RESULT_FAILURE;
          trans.setOutcome(constants.OUTCOME_FAILURE);
        } else {
          trans.result = constants.RESULT_SUCCESS;
          trans.setOutcome(constants.OUTCOME_SUCCESS);
        }
        break;
    }

    if (err) {
      agent.captureError(err, { skipOutcome: true });
    }

    trans.end();

    agent._flush({ lambdaEnd: true, inflightTimeout: 100 }, (flushErr) => {
      if (flushErr) {
        log.error(
          { err: flushErr, awsRequestId: context && context.awsRequestId },
          'lambda: flush error',
        );
      }
      log.trace(
        { awsRequestId: context && context.awsRequestId },
        'lambda: wrapper end',
      );
      cb();
    });
  }

  function wrapContext(runContext, trans, event, context, triggerType) {
    shimmer.wrap(context, 'succeed', (origSucceed) => {
      return ins.bindFunctionToRunContext(
        runContext,
        function wrappedSucceed(result) {
          endAndFlushTransaction(
            null,
            result,
            trans,
            event,
            context,
            triggerType,
            function () {
              origSucceed(result);
            },
          );
        },
      );
    });

    shimmer.wrap(context, 'fail', (origFail) => {
      return ins.bindFunctionToRunContext(
        runContext,
        function wrappedFail(err) {
          endAndFlushTransaction(
            err,
            null,
            trans,
            event,
            context,
            triggerType,
            function () {
              origFail(err);
            },
          );
        },
      );
    });

    shimmer.wrap(context, 'done', (origDone) => {
      return wrapLambdaCallback(
        runContext,
        trans,
        event,
        context,
        triggerType,
        origDone,
      );
    });
  }

  function wrapLambdaCallback(
    runContext,
    trans,
    event,
    context,
    triggerType,
    callback,
  ) {
    return ins.bindFunctionToRunContext(
      runContext,
      function wrappedLambdaCallback(err, result) {
        endAndFlushTransaction(
          err,
          result,
          trans,
          event,
          context,
          triggerType,
          () => {
            callback(err, result);
          },
        );
      },
    );
  }

  return function wrapLambdaHandler(type, fn) {
    if (typeof type === 'function') {
      fn = type;
      type = 'request';
    }
    if (!agent._conf.active) {
      // Manual usage of `apm.lambda(...)` should be a no-op when not active.
      return fn;
    }

    return async function wrappedLambdaHandler(event, context, callback) {
      if (!(event && context && typeof callback === 'function')) {
        // Skip instrumentation if arguments are unexpected.
        // https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html
        return fn.call(this, ...arguments);
      }
      log.trace({ awsRequestId: context.awsRequestId }, 'lambda: fn start');

      const isColdStart = isFirstRun;
      if (isFirstRun) {
        isFirstRun = false;

        // E.g. 'arn:aws:lambda:us-west-2:123456789012:function:my-function:someAlias'
        const arnParts = context.invokedFunctionArn.split(':');
        gFaasId = arnParts.slice(0, 7).join(':');
        const cloudAccountId = arnParts[4];

        if (agent._apmClient) {
          log.trace(
            { awsRequestId: context.awsRequestId },
            'lambda: setExtraMetadata',
          );
          agent._apmClient.setExtraMetadata(getMetadata(agent, cloudAccountId));
        }
      }

      if (agent._apmClient) {
        agent._apmClient.lambdaStart();
      }

      const triggerType = triggerTypeFromEvent(event);

      // Look for trace-context info in headers or messageAttributes.
      let traceparent;
      let tracestate;
      if (
        (triggerType === TRIGGER_API_GATEWAY || triggerType === TRIGGER_ELB) &&
        event.headers
      ) {
        if (!event.requestContext.http) {
          // 1.0
          event.normedHeaders = lowerCaseObjectKeys(event.headers);
        } else {
          event.normedHeaders = event.headers;
        }
        traceparent =
          event.normedHeaders.traceparent ||
          event.normedHeaders['mtn-apm-traceparent'];
        tracestate = event.normedHeaders.tracestate;
      }

      // Start the transaction and set some possibly trigger-specific data.
      const trans = agent.startTransaction(context.functionName, type, {
        childOf: traceparent,
        tracestate,
      });
      switch (triggerType) {
        case TRIGGER_API_GATEWAY:
          setApiGatewayData(agent, trans, event, context, gFaasId, isColdStart);
          break;
        case TRIGGER_ELB:
          setElbData(agent, trans, event, context, gFaasId, isColdStart);
          break;
        case TRIGGER_SQS:
          setSqsData(agent, trans, event, context, gFaasId, isColdStart);
          break;
        case TRIGGER_SNS:
          setSnsData(agent, trans, event, context, gFaasId, isColdStart);
          break;
        case TRIGGER_S3_SINGLE_EVENT:
          setS3SingleData(trans, event, context, gFaasId, isColdStart);
          break;
        case TRIGGER_GENERIC:
          setGenericData(trans, event, context, gFaasId, isColdStart);
          break;
        default:
          log.warn(
            `not setting transaction data for triggerType=${triggerType}`,
          );
      }

      const transRunContext = ins.currRunContext();
      wrapContext(transRunContext, trans, event, context, triggerType);
      const wrappedCallback = wrapLambdaCallback(
        transRunContext,
        trans,
        event,
        context,
        triggerType,
        callback,
      );

      await registerTransaction(trans, context.awsRequestId);

      try {
        const retval = ins.withRunContext(
          transRunContext,
          fn,
          this,
          event,
          context,
          wrappedCallback,
        );
        if (retval instanceof Promise) {
          return retval;
        } else {
          return new Promise((resolve, reject) => {
            /* never resolves */
          });
        }
      } catch (handlerErr) {
        wrappedCallback(handlerErr);
        // Return a promise that never resolves, so that the Lambda Runtime's
        // doesn't attempt its "success" handling.
        return new Promise((resolve, reject) => {
          /* never resolves */
        });
      }
    };
  };
}

function isLambdaExecutionEnvironment() {
  return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

function getFilePath(taskRoot, moduleRoot, module) {
  const lambdaStylePath = path.resolve(taskRoot, moduleRoot, module);
  if (fs.existsSync(lambdaStylePath + '.js')) {
    return lambdaStylePath + '.js';
  } else if (fs.existsSync(lambdaStylePath + '.cjs')) {
    return lambdaStylePath + '.cjs';
  } else {
    return null;
  }
}

/**
 * @param {object} env - The process environment.
 * @param {any} [logger] - Optional logger for trace/warn log output.
 */
function getLambdaHandlerInfo(env, logger) {
  if (
    !isLambdaExecutionEnvironment() ||
    !env._HANDLER ||
    !env.LAMBDA_TASK_ROOT
  ) {
    return null;
  }

  const fullHandlerString = env._HANDLER;
  const moduleAndHandler = path.basename(fullHandlerString);
  const moduleRoot = fullHandlerString.substring(
    0,
    fullHandlerString.indexOf(moduleAndHandler),
  );
  const FUNCTION_EXPR = /^([^.]*)\.(.*)$/;
  const match = moduleAndHandler.match(FUNCTION_EXPR);
  if (!match || match.length !== 3) {
    if (logger) {
      logger.warn(
        { fullHandlerString, moduleAndHandler },
        'Lambda handler string did not match FUNCTION_EXPR',
      );
    }
    return null;
  }
  const module = match[1];
  const handlerPath = match[2];

  const moduleAbsPath = getFilePath(env.LAMBDA_TASK_ROOT, moduleRoot, module);
  if (!moduleAbsPath) {
    if (logger) {
      logger.warn(
        { fullHandlerString, moduleRoot, module },
        'could not find Lambda handler module file (ESM not yet supported)',
      );
    }
    return null;
  }

  const lambdaHandlerInfo = {
    filePath: moduleAbsPath,
    modName: module,
    propPath: handlerPath,
  };
  if (logger) {
    logger.trace({ fullHandlerString, lambdaHandlerInfo }, 'lambdaHandlerInfo');
  }
  return lambdaHandlerInfo;
}

function lowerCaseObjectKeys(obj) {
  const lowerCased = {};
  for (const key of Object.keys(obj)) {
    lowerCased[key.toLowerCase()] = obj[key];
  }
  return lowerCased;
}

function spanLinksFromSqsRecords(records) {
  const links = [];
  const limit = Math.min(
    records.length,
    MAX_MESSAGES_PROCESSED_FOR_TRACE_CONTEXT,
  );
  for (let i = 0; i < limit; i++) {
    const attrs = records[i].messageAttributes;
    if (!attrs) {
      continue;
    }

    let traceparent;
    const attrNames = Object.keys(attrs);
    for (let j = 0; j < attrNames.length; j++) {
      const attrVal = attrs[attrNames[j]];
      if (attrVal.dataType !== 'String') {
        continue;
      }
      const attrNameLc = attrNames[j].toLowerCase();
      if (attrNameLc === 'traceparent') {
        traceparent = attrVal.stringValue;
        break;
      }
    }
    if (traceparent) {
      links.push({ context: traceparent });
    }
  }
  return links;
}

function spanLinksFromSnsRecords(records) {
  const links = [];
  const limit = Math.min(
    records.length,
    MAX_MESSAGES_PROCESSED_FOR_TRACE_CONTEXT,
  );
  for (let i = 0; i < limit; i++) {
    const attrs = records[i].Sns && records[i].Sns.MessageAttributes;
    if (!attrs) {
      continue;
    }

    let traceparent;
    const attrNames = Object.keys(attrs);
    for (let j = 0; j < attrNames.length; j++) {
      const attrVal = attrs[attrNames[j]];
      if (attrVal.Type !== 'String') {
        continue;
      }
      const attrNameLc = attrNames[j].toLowerCase();
      if (attrNameLc === 'traceparent') {
        traceparent = attrVal.Value;
        break;
      }
    }
    if (traceparent) {
      links.push({ context: traceparent });
    }
  }
  return links;
}

module.exports = {
  isLambdaExecutionEnvironment,
  mtnApmAwsLambda,
  getLambdaHandlerInfo,
};
