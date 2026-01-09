'use strict';

const http = require('http');
const path = require('path');

const isError = require('core-util-is').isError;
const Filters = require('object-filter-sequence');

const { agentActivationMethodFromStartStack } = require('./activation-method');
const {
  CAPTURE_ERROR_LOG_STACK_TRACES_ALWAYS,
  CAPTURE_ERROR_LOG_STACK_TRACES_MESSAGES,
} = require('./constants');
const config = require('./config/config');
const connect = require('./middleware/connect');
const constants = require('./constants');
const errors = require('./errors');
const { InflightEventSet } = require('./InflightEventSet');
const { Instrumentation } = require('./instrumentation');
const logging = require('./logging');
const Metrics = require('./metrics');
const parsers = require('./parsers');
const symbols = require('./symbols');
const { frameCacheStats, initStackTraceCollection } = require('./stacktraces');
const Span = require('./instrumentation/span');
const Transaction = require('./instrumentation/transaction');
const {
  isOTelMetricsFeatSupported,
  createOTelMeterProvider,
} = require('./opentelemetry-metrics');
const { createApmClient } = require('./apm-client/apm-client');

const IncomingMessage = http.IncomingMessage;
const ServerResponse = http.ServerResponse;

const version = require('../package').version;


module.exports = Agent;

function Agent() {
  this.logger = config.configLogger();
  this._conf = config.initialConfig(this.logger);

  this._httpClient = null;
  this._uncaughtExceptionListener = null;
  this._inflightEvents = new InflightEventSet();
  this._instrumentation = new Instrumentation(this);
  this._metrics = new Metrics(this);
  this._otelMeterProvider = null;
  this._errorFilters = new Filters();
  this._transactionFilters = new Filters();
  this._spanFilters = new Filters();
  this._apmClient = null;

  this.middleware = { connect: connect.bind(this) };
}

// Current context accessors


Object.defineProperty(Agent.prototype, 'currentOperation', {
  get() {
    return this._instrumentation.currTransaction();
  },
});

Object.defineProperty(Agent.prototype, 'currentStep', {
  get() {
    return this._instrumentation.currSpan();
  },
});

Object.defineProperty(Agent.prototype, 'currentTraceparent', {
  get() {
    const current =
      this._instrumentation.currSpan() ||
      this._instrumentation.currTransaction();
    return current ? current.traceparent : null;
  },
});

Object.defineProperty(Agent.prototype, 'currentTraceIds', {
  get() {
    return this._instrumentation.ids();
  },
});


// Lifecycle


Agent.prototype.destroy = async function () {
  if (this._otelMeterProvider) {
    try {
      await this._otelMeterProvider.shutdown({ timeoutMillis: 1000 });
    } catch (err) {
      this.logger.warn('failed to shutdown OTel MeterProvider:', err);
    }
    this._otelMeterProvider = null;
  }

  if (this._apmClient && this._apmClient.destroy) {
    this._apmClient.destroy();
  }

  this._apmClient = null;
  this._errorFilters = new Filters();
  this._transactionFilters = new Filters();
  this._spanFilters = new Filters();

  if (this._uncaughtExceptionListener) {
    process.removeListener(
      'uncaughtException',
      this._uncaughtExceptionListener,
    );
  }

  this._metrics.stop();
  this._instrumentation.stop();

  global[symbols.agentInitialized] = null;

  if (
    this._origStackTraceLimit &&
    Error.stackTraceLimit !== this._origStackTraceLimit
  ) {
    Error.stackTraceLimit = this._origStackTraceLimit;
  }
};


//  public API (ops & steps)


Agent.prototype.startOperation = function (name, options = {}) {
  return this.startTransaction(
    name,
    options.type || 'operation',
    options,
  );
};

Agent.prototype.endOperation = function (result, endTime) {
  return this.endTransaction(result, endTime);
};

Agent.prototype.startStep = function (name, options = {}) {
  return this.startSpan(
    name,
    options.type,
    options.subtype,
    options.action,
    options,
  );
};

Agent.prototype.reportError = function (err, opts, cb) {
  return this.captureError(err, opts, cb);
};


// Internal transaction/span handling


Agent.prototype.startTransaction = function (
  name,
  type,
  { startTime, childOf } = {},
) {
  return this._instrumentation.startTransaction.apply(
    this._instrumentation,
    arguments,
  );
};

Agent.prototype.endTransaction = function (result, endTime) {
  return this._instrumentation.endTransaction.apply(
    this._instrumentation,
    arguments,
  );
};

Agent.prototype.startSpan = function (
  name,
  type,
  subtype,
  action,
  { startTime, childOf, exitSpan } = {},
) {
  return this._instrumentation.startSpan.apply(
    this._instrumentation,
    arguments,
  );
};

// startup 

Agent.prototype.isStarted = function () {
  return global[symbols.agentInitialized];
};

Agent.prototype.start = function (opts) {
  if (this.isStarted()) {
    throw new Error('Do not call .start() more than once');
  }
  global[symbols.agentInitialized] = true;

  this._conf = config.createConfig(opts, this.logger);
  this.logger = this._conf.logger;

  if (!this._conf.active) {
    this.logger.debug('MTN APM agent disabled');
    return this;
  }

  this.logger.info('MTN Observability Agent v%s', version);

  if (!this._conf.endpoint || !this._conf.serviceName) {
    this.logger.error('MTN APM misconfiguration detected, agent disabled');
    this._conf.active = false;
    return this;
  }

  initStackTraceCollection();
  this._apmClient = createApmClient(this._conf, this);

  this._instrumentation.start();

  if (this._conf.metricsInterval !== 0) {
    this._metrics.start();
  }

  if (this._conf.captureExceptions) {
    this.handleUncaughtExceptions();
  }

  return this;
};

// Error capture, flushing, metrics implementation


Agent.prototype.captureError = function (err, opts, cb) {
  return errors.captureError
    ? errors.captureError.apply(this, arguments)
    : undefined;
};

Agent.prototype.flush = function (cb) {
  if (!this._apmClient) return;
  return typeof cb === 'function'
    ? this._apmClient.flush(cb)
    : new Promise((resolve) => this._apmClient.flush(resolve));
};

Agent.prototype.registerMetric = function (name, labelsOrCallback, callback) {
  this._metrics.getOrCreateGauge(name, callback, labelsOrCallback);
};
