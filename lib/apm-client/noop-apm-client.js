'use strict';

class NoopApmClient {
  config(opts) {}

  addMetadataFilter(fn) {}
  setExtraMetadata(metadata) {}

  lambdaStart() {}
  lambdaShouldRegisterTransactions() {
    return true;
  }
  lambdaRegisterTransaction(trans, awsRequestId) {}

  sendSpan(span, cb) {
    if (cb) {
      process.nextTick(cb);
    }
  }

  sendTransaction(transaction, cb) {
    if (cb) {
      process.nextTick(cb);
    }
  }

  sendError(_error, cb) {
    if (cb) {
      process.nextTick(cb);
    }
  }

  sendMetricSet(metricset, cb) {
    if (cb) {
      process.nextTick(cb);
    }
  }

  flush(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    } else if (!opts) {
      opts = {};
    }
    if (cb) {
      process.nextTick(cb);
    }
  }

  supportsKeepingUnsampledTransaction() {
    return true;
  }

  // Inherited from Writable, called in agent.js.
  destroy() {}
}

module.exports = {
  NoopApmClient,
};
