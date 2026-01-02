'use strict';

// Instrument AWS S3 operations via the 'aws-sdk' package.

const constants = require('../../../constants');

const TYPE = 'storage';
const SUBTYPE = 's3';

function opNameFromOperation(operation) {
  return operation[0].toUpperCase() + operation.slice(1);
}


function resourceFromBucket(bucket) {
  let resource = null;
  if (bucket) {
    resource = bucket;
    if (resource.startsWith('arn:')) {
      resource = bucket.split(':').slice(5).join(':');
    }
  }
  return resource;
}

// Instrument an awk-sdk@2.x operation (i.e. a AWS.Request.send or
// AWS.Request.promise).
function instrumentationS3(
  orig,
  origArguments,
  request,
  AWS,
  agent,
  { version, enabled },
) {
  const opName = opNameFromOperation(request.operation);
  const params = request.params;
  const bucket = params && params.Bucket;
  const resource = resourceFromBucket(bucket);
  let name = 'S3 ' + opName;
  if (resource) {
    name += ' ' + resource;
  }

  const ins = agent._instrumentation;

  const span = ins.createSpan(name, TYPE, SUBTYPE, opName, { exitSpan: true });
  if (!span) {
    return orig.apply(request, origArguments);
  }

  if (bucket) {
    const otelAttrs = span._getOTelAttributes();

    otelAttrs['aws.s3.bucket'] = bucket;

    if (params.Key) {
      otelAttrs['aws.s3.key'] = params.Key;
    }
  }

  const onComplete = function (response) {
    // `response` is an AWS.Response
    const httpRequest = request.httpRequest;
    const region = httpRequest && httpRequest.region;

    span.setServiceTarget('s3', resource);
    const destContext = {};
    // '.httpRequest.endpoint' might differ from '.service.endpoint' if
    // the bucket is in a different region.
    const endpoint = httpRequest && httpRequest.endpoint;
    if (endpoint) {
      destContext.address = endpoint.hostname;
      destContext.port = endpoint.port;
    }
    if (region) {
      destContext.cloud = { region };
    }
    span._setDestinationContext(destContext);

    if (response) {
    
      const httpResponse = response.httpResponse;
      let statusCode;
      if (httpResponse) {
        statusCode = httpResponse.statusCode;

     
        const httpContext = {
          status_code: statusCode,
        };
        const encodedBodySize =
          Buffer.isBuffer(httpResponse.body) && httpResponse.body.byteLength;
        if (encodedBodySize) {
          // I'm not actually sure if this might be decoded_body_size.
          httpContext.response = { encoded_body_size: encodedBodySize };
        }
        span.setHttpContext(httpContext);
      }

     
      if (statusCode) {
        span._setOutcomeFromHttpStatusCode(statusCode);
      } else {
        // `statusCode` will be undefined for errors before sending a request, e.g.:
        //  InvalidConfiguration: Custom endpoint is not compatible with access point ARN
        span._setOutcomeFromErrorCapture(constants.OUTCOME_FAILURE);
      }

      if (response.error && (!statusCode || statusCode >= 400)) {
        agent.captureError(response.error, { skipOutcome: true });
      }
    }

    span.end();
  };

  // Run context notes: The `orig` should run in the context of the S3 span,
  // because that is the point. The user's callback `cb` should run outside of
  // the S3 span.
  const parentRunContext = ins.currRunContext();
  const spanRunContext = parentRunContext.enterSpan(span);
  const cb = origArguments[origArguments.length - 1];
  if (typeof cb === 'function') {
    origArguments[origArguments.length - 1] = ins.bindFunctionToRunContext(
      parentRunContext,
      cb,
    );
  }
  request.on(
    'complete',
    ins.bindFunctionToRunContext(spanRunContext, onComplete),
  );
  return ins.withRunContext(spanRunContext, orig, request, ...origArguments);
}

module.exports = {
  instrumentationS3,
};
