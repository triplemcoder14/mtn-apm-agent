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
const { mtnApmAwsLambda } = require('./lambda');
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

// ---- Agent

module.exports = Agent;

function Agent() {
  // Early configuration to ensure `agent.logger` works before `agent.start()`.
  this.logger = config.configLogger();

  // Get an initial pre-.start() configuration of agent defaults. This is a
  // crutch for Agent APIs that depend on `agent._conf`.
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

  this.lambda = mtnApmAwsLambda(this);
  this.middleware = { connect: connect.bind(this) };
}

// normaliz globalLabels into the internal format used by this agent:
// an array of [key, value] pairs.
function normalizeGlobalLabels(globalLabels) {
  if (!globalLabels) return [];
  if (Array.isArray(globalLabels)) return globalLabels;
  if (typeof globalLabels === 'object') return Object.entries(globalLabels);
  return [];
}

// Add default global labels without overwriting user-provided ones.
function applyDefaultGlobalLabels(conf) {
  const defaults = [
    ['agentName', 'mtn-apm-agent'],
    ['maintainer', 'mtn-sre-team'],
    ['coreMaintainer', 'muutassim.mukhtar@mtn.com'],
  ];

  const existingPairs = normalizeGlobalLabels(conf.globalLabels);
  const existingMap = new Map(existingPairs);

  for (const [k, v] of defaults) {
    if (!existingMap.has(k)) existingMap.set(k, v);
  }

  conf.globalLabels = Array.from(existingMap.entries());
}

Object.defineProperty(Agent.prototype, 'currentTransaction', {
  get() {
    return this._instrumentation.currTransaction();
  },
});

Object.defineProperty(Agent.prototype, 'currentSpan', {
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

Agent.prototype.destroy = async function () {
  if (this._otelMeterProvider) {
    // This will call `Agent#flush()`.
    try {
      await this._otelMeterProvider.shutdown({ timeoutMillis: 1000 });
    } catch (reason) {
      this.logger.warn('failed to shutdown OTel MeterProvider:', reason);
    }
    this._otelMeterProvider = null;
  }

  if (this._apmClient && this._apmClient.destroy) {
    this._apmClient.destroy();
  }
  // So in-flight tasks in ins.addEndedSpan() and agent.captureError() do
  // not use the destroyed transport.
  this._apmClient = null;

  // So in-flight tasks do not call user-added filters after the agent has
  // been destroyed.
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

  // Allow a new Agent instance to `.start()`. Typically this is only relevant
  // for tests that may use multiple Agent instances in a single test process.
  global[symbols.agentInitialized] = null;

  if (
    this._origStackTraceLimit &&
    Error.stackTraceLimit !== this._origStackTraceLimit
  ) {
    Error.stackTraceLimit = this._origStackTraceLimit;
  }
};

// These are metrics about the agent itself -- separate from the metrics
// gathered on behalf of the using app and sent to APM server. Currently these
// are only useful for internal debugging of the APM agent itself.
//
// **These stats are NOT a promised interface.**
Agent.prototype._getStats = function () {
  const stats = {
    frameCache: frameCacheStats,
  };
  if (
    this._instrumentation._runCtxMgr &&
    this._instrumentation._runCtxMgr._runContextFromAsyncId
  ) {
    stats.runContextFromAsyncIdSize =
      this._instrumentation._runCtxMgr._runContextFromAsyncId.size;
  }
  if (this._apmClient && typeof this._apmClient._getStats === 'function') {
    stats.apmclient = this._apmClient._getStats();
  }
  return stats;
};

Agent.prototype.addPatch = function (modules, handler) {
  return this._instrumentation.addPatch.apply(this._instrumentation, arguments);
};

Agent.prototype.removePatch = function (modules, handler) {
  return this._instrumentation.removePatch.apply(
    this._instrumentation,
    arguments,
  );
};

Agent.prototype.clearPatches = function (modules) {
  return this._instrumentation.clearPatches.apply(
    this._instrumentation,
    arguments,
  );
};

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

Agent.prototype.setTransactionName = function (name) {
  return this._instrumentation.setTransactionName.apply(
    this._instrumentation,
    arguments,
  );
};

/**
 *
 * @param {string} outcome must be one of `failure`, `success`, or `unknown`
 */
Agent.prototype.setTransactionOutcome = function (outcome) {
  return this._instrumentation.setTransactionOutcome.apply(
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

/**
 *
 * @param {string} outcome must be one of `failure`, `success`, or `unknown`
 */
Agent.prototype.setSpanOutcome = function (outcome) {
  return this._instrumentation.setSpanOutcome.apply(
    this._instrumentation,
    arguments,
  );
};

Agent.prototype._config = function (opts) {
  this._conf = config.createConfig(opts, this.logger);
  this.logger = this._conf.logger;
};

Agent.prototype.isStarted = function () {
  return global[symbols.agentInitialized];
};

Agent.prototype.start = function (opts) {
  if (this.isStarted()) {
    throw new Error('Do not call .start() more than once');
  }
  global[symbols.agentInitialized] = true;

  this._config(opts);


  applyDefaultGlobalLabels(this._conf);

  if (!this._conf.active) {
    this.logger.debug('MTN APM agent disabled (`active` is false)');
    return this;
  }

  // Log preamble showing agent, environment and config relevant info
  const preambleData = this._conf.loggingPreambleData;
  const isPreviewVersion = version.indexOf('-') !== -1;
  const startStack = {};

  if (this._conf.active && this._conf.serviceName) {
    this._origStackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 20; // require more than default 10 for `agentActivationMethodFromStartStack()`
    Error.captureStackTrace(startStack);
    Error.stackTraceLimit = this._origStackTraceLimit;
    this._agentActivationMethod = agentActivationMethodFromStartStack(
      startStack,
      this.logger,
    );
    preambleData.activationMethod = this._agentActivationMethod;

    if (this._conf.logLevel === 'trace') {
      // Attempt to load package.json from process.argv.
      let pkg = null;
      try {
        var basedir = path.dirname(process.argv[1] || '.');
        pkg = require(path.join(basedir, 'package.json'));
      } catch (e) {}

      // Add stack & dependencies for extra information
      preambleData.dependencies = pkg
        ? pkg.dependencies
        : '<could not determine>';
      preambleData.startTrace = startStack.stack.split(/\n */).slice(1);
    }
  }

  this.logger.info(preambleData, 'MTN APM Node.js Agent v%s', version);

  if (!logging.isLoggerCustom(this.logger)) {
    // Periodically dump the current config (delta from defaults) when logging
    // at "trace"-level. This allows getting the effective config from a running
    // agent by setting trace-level logging and getting 1 minute of logs.
    // (Sometimes getting logs from application *start* is no possible.)
    setInterval(() => {
      if (this.logger.isLevelEnabled('trace')) {
        try {
          const currConfig = this._conf.getCurrConfig();
          this.logger.trace({ currConfig }, 'currConfig');
        } catch (err) {
          this.logger.trace({ err }, 'error calculating currConfig');
        }
      }
    }, 60 * 1000).unref();
  }

  if (isPreviewVersion) {
    this.logger.warn(
      'Version %s is a pre-release and not intended for use in production environments',
      version,
    );
  }

  if (!this._conf.endpoint) {
    this.logger.error(
      'MTN APM is incorrectly configured: Invalid endpoint (APM will be disabled)',
    );
    this._conf.active = false;
    return this;
  }

  if (!this._conf.serviceName) {
    this.logger.error(
      'MTN APM is incorrectly configured: Missing serviceName (APM will be disabled)',
    );
    this._conf.active = false;
    return this;
  }

  initStackTraceCollection();
  this._apmClient = createApmClient(this._conf, this);

  let runContextClass;
  if (this._conf.opentelemetryBridgeEnabled) {
    const {
      setupOTelBridge,
      OTelBridgeRunContext,
    } = require('./opentelemetry-bridge');
    runContextClass = OTelBridgeRunContext;
    setupOTelBridge(this);
  }
  this._instrumentation.start(runContextClass);

  if (this._isMetricsEnabled()) {
    this._metrics.start();
  }

  Error.stackTraceLimit = this._conf.stackTraceLimit;
  if (this._conf.captureExceptions) this.handleUncaughtExceptions();

  return this;
};

Agent.prototype._isMetricsEnabled = function () {
  return this._conf.metricsInterval !== 0 && !this._conf.contextPropagationOnly;
};

/**
 * Lazily create a singleton OTel MeterProvider that periodically exports
 * metrics to APM server. This may return null if the MeterProvider is
 * unsupported for this node version, metrics are disabled, etc.
 *
 * @returns {import('@opentelemetry/api').MeterProvider | null}
 */
Agent.prototype._getOrCreateOTelMeterProvider = function () {
  if (this._otelMeterProvider) {
    return this._otelMeterProvider;
  }

  if (!this._isMetricsEnabled()) {
    return null;
  }
  if (!isOTelMetricsFeatSupported) {
    return null;
  }

  this.logger.trace('create MTN APM MeterProvider for @opentelemetry/api');
  this._otelMeterProvider = createOTelMeterProvider(this);
  return this._otelMeterProvider;
};

Agent.prototype.getServiceName = function () {
  return this._conf ? this._conf.serviceName : undefined;
};

Agent.prototype.getServiceVersion = function () {
  return this._conf ? this._conf.serviceVersion : undefined;
};

Agent.prototype.getServiceEnvironment = function () {
  return this._conf ? this._conf.environment : undefined;
};

Agent.prototype.getServiceNodeName = function () {
  return this._conf ? this._conf.serviceNodeName : undefined;
};

Agent.prototype.setFramework = function ({ name, version, overwrite = true }) {
  if (!this._apmClient || !this._conf) {
    return;
  }
  const conf = {};
  if (name && (overwrite || !this._conf.frameworkName))
    this._conf.frameworkName = conf.frameworkName = name;
  if (version && (overwrite || !this._conf.frameworkVersion))
    this._conf.frameworkVersion = conf.frameworkVersion = version;
  this._apmClient.config(conf);
};

Agent.prototype.setUserContext = function (context) {
  var trans = this._instrumentation.currTransaction();
  if (!trans) return false;
  trans.setUserContext(context);
  return true;
};

Agent.prototype.setCustomContext = function (context) {
  var trans = this._instrumentation.currTransaction();
  if (!trans) return false;
  trans.setCustomContext(context);
  return true;
};

Agent.prototype.setGlobalLabel = function (key, value) {
  if (!this._conf.globalLabels) this._conf.globalLabels = [];
  const foundPos = this._conf.globalLabels.findIndex(([name]) => key === name);
  if (foundPos > -1) {
    this._conf.globalLabels[foundPos][1] = value;
  } else {
    this._conf.globalLabels.push([key, value]);
  }
  if (!this._apmClient) {
    this.logger.warn('cannot setGlobalLabel on inactive or unconfigured agent');
    return;
  }
  this._apmClient.config({
    globalLabels: this._conf.globalLabels.reduce((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {}),
  });
};

Agent.prototype.setLabel = function (key, value, stringify) {
  var trans = this._instrumentation.currTransaction();
  if (!trans) return false;
  return trans.setLabel(key, value, stringify);
};

Agent.prototype.addLabels = function (labels, stringify) {
  var trans = this._instrumentation.currTransaction();
  if (!trans) return false;
  return trans.addLabels(labels, stringify);
};

Agent.prototype.addFilter = function (fn) {
  this.addErrorFilter(fn);
  this.addTransactionFilter(fn);
  this.addSpanFilter(fn);
};

Agent.prototype.addErrorFilter = function (fn) {
  if (typeof fn !== 'function') {
    this.logger.error("Can't add filter of type %s", typeof fn);
    return;
  }

  this._errorFilters.push(fn);
};

Agent.prototype.addTransactionFilter = function (fn) {
  if (typeof fn !== 'function') {
    this.logger.error("Can't add filter of type %s", typeof fn);
    return;
  }

  this._transactionFilters.push(fn);
};

Agent.prototype.addSpanFilter = function (fn) {
  if (typeof fn !== 'function') {
    this.logger.error("Can't add filter of type %s", typeof fn);
    return;
  }

  this._spanFilters.push(fn);
};

Agent.prototype.addMetadataFilter = function (fn) {
  if (typeof fn !== 'function') {
    this.logger.error("Can't add filter of type %s", typeof fn);
    return;
  } else if (!this._apmClient) {
    this.logger.error(
      'cannot add metadata filter to inactive or unconfigured agent (agent has no transport)',
    );
    return;
  } else if (typeof this._apmClient.addMetadataFilter !== 'function') {
    // Graceful failure if unexpectedly using a too-old APM client.
    this.logger.error(
      'cannot add metadata filter: transport does not support addMetadataFilter',
    );
    return;
  }

  // Metadata filters are handled by the APM client, where metadata is
  // processed.
  this._apmClient.addMetadataFilter(fn);
};

const EMPTY_OPTS = {};

Agent.prototype.captureError = function (err, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = EMPTY_OPTS;
  } else if (!opts) {
    opts = EMPTY_OPTS;
  }

  const id = errors.generateErrorId();

  if (!this.isStarted()) {
    if (cb) {
      cb(new Error('cannot capture error before agent is started'), id);
    }
    return;
  }

  // Avoid unneeded error/stack processing if only propagating trace-context.
  if (this._conf.contextPropagationOnly) {
    if (cb) {
      process.nextTick(cb, null, id);
    }
    return;
  }

  const agent = this;
  let callSiteLoc = null;
  const errIsError = isError(err);
  const handled = opts.handled !== false; // default true
  const shouldCaptureAttributes = opts.captureAttributes !== false; // default true
  const skipOutcome = Boolean(opts.skipOutcome);
  const timestampUs = opts.timestamp
    ? Math.floor(opts.timestamp * 1000)
    : Date.now() * 1000;

  // Determine transaction/span context to associate with this error.
  let parent;
  let span;
  let trans;
  if (opts.parent === undefined) {
    parent =
      this._instrumentation.currSpan() ||
      this._instrumentation.currTransaction();
  } else if (opts.parent === null) {
    parent = null;
  } else {
    parent = opts.parent;
  }
  if (parent instanceof Transaction) {
    span = null;
    trans = parent;
  } else if (parent instanceof Span) {
    span = parent;
    trans = parent.transaction;
  }
  const traceContext = (span || trans || {})._context;
  const req =
    opts.request instanceof IncomingMessage ? opts.request : trans && trans.req;
  const res =
    opts.response instanceof ServerResponse
      ? opts.response
      : trans && trans.res;

  // As an added feature, for *some* cases, we capture a stacktrace at the point
  // this `captureError` was called. This is added to `error.log.stacktrace`.
  if (
    handled &&
    (agent._conf.captureErrorLogStackTraces ===
      CAPTURE_ERROR_LOG_STACK_TRACES_ALWAYS ||
      (!errIsError &&
        agent._conf.captureErrorLogStackTraces ===
          CAPTURE_ERROR_LOG_STACK_TRACES_MESSAGES))
  ) {
    callSiteLoc = {};
    Error.captureStackTrace(callSiteLoc, Agent.prototype.captureError);
  }

  if (span && !skipOutcome) {
    span._setOutcomeFromErrorCapture(constants.OUTCOME_FAILURE);
  }

  // Note this error as an "inflight" event. See Agent#flush().
  const inflightEvents = this._inflightEvents;
  inflightEvents.add(id);


  setImmediate(() => {
    // Gather `error.context.*`.
    const errorContext = {
      user: Object.assign(
        {},
        req && parsers.getUserContextFromRequest(req),
        trans && trans._user,
        opts.user,
      ),
      tags: Object.assign({}, trans && trans._labels, opts.tags, opts.labels),
      custom: Object.assign({}, trans && trans._custom, opts.custom),
    };
    if (req) {
      errorContext.request = parsers.getContextFromRequest(
        req,
        agent._conf,
        'errors',
      );
    }
    if (res) {
      errorContext.response = parsers.getContextFromResponse(
        res,
        agent._conf,
        true,
      );
    }

    errors.createAPMError(
      {
        log: agent.logger,
        id,
        exception: errIsError ? err : null,
        logMessage: errIsError ? null : err,
        shouldCaptureAttributes,
        timestampUs,
        handled,
        callSiteLoc,
        message: opts.message,
        sourceLinesAppFrames: agent._conf.sourceLinesErrorAppFrames,
        sourceLinesLibraryFrames: agent._conf.sourceLinesErrorLibraryFrames,
        trans,
        traceContext,
        errorContext,
        exceptionType: opts.exceptionType,
      },
      function filterAndSendError(_err, apmError) {
        // _err is always null from createAPMError.

        apmError = agent._errorFilters.process(apmError);
        if (!apmError) {
          agent.logger.debug('error ignored by filter %o', { id });
          inflightEvents.delete(id);
          if (cb) {
            cb(null, id);
          }
          return;
        }

        if (agent._apmClient) {
          agent.logger.debug('Sending error to MTN APM: %o', { id });
          agent._apmClient.sendError(apmError);
          inflightEvents.delete(id);
          if (!handled || cb) {
            // Immediately flush *unhandled* errors -- those from
            // `uncaughtException` -- on the assumption that the process may
            // soon crash. Also flush when a `cb` is provided.
            agent.flush(function (flushErr) {
              if (cb) {
                cb(flushErr, id);
              }
            });
          }
        } else {
          inflightEvents.delete(id);
          if (cb) {
            cb(new Error('cannot send error: missing transport'), id);
          }
        }
      },
    );
  });
};


Agent.prototype.handleUncaughtExceptions = function (cb) {
  var agent = this;

  if (this._uncaughtExceptionListener) {
    process.removeListener(
      'uncaughtException',
      this._uncaughtExceptionListener,
    );
  }

  this._uncaughtExceptionListener = function (err) {
    agent.logger.debug({ err }, 'MTN APM caught unhandled exception');
 
    console.error(err);

    agent.captureError(err, { handled: false }, function () {
      cb ? cb(err) : process.exit(1);
    });
  };

  process.on('uncaughtException', this._uncaughtExceptionListener);
};


Agent.prototype.flush = function (cb) {
  // This 1s timeout is a subjective balance between "long enough for spans
  // and errors to reasonably encode" and "short enough to not block data
  // being reported to APM server".
  const DEFAULT_INFLIGHT_FLUSH_TIMEOUT_MS = 1000;

  // shared options for the private `._flush()` API.
  const opts = { inflightTimeoutMs: DEFAULT_INFLIGHT_FLUSH_TIMEOUT_MS };

  if (typeof cb !== 'function') {
    return new Promise((resolve, reject) => {
      this._flush(opts, (err) => {
        if (err) {
          reject(err);
        }

        resolve();
      });
    });
  }

  return this._flush(opts, cb);
};


Agent.prototype._flush = function (opts, cb) {
  const lambdaEnd = !!opts.lambdaEnd;

  if (!this._apmClient) {
    // Log an *err* to provide a stack for the user.
    const err = new Error('cannot flush agent before it is started');
    this.logger.warn({ err }, err.message);
    if (cb) {
      process.nextTick(cb);
    }
    return;
  }

  const boundCb = cb && this._instrumentation.bindFunction(cb);

  // If there are no inflight events then avoid creating additional objects.
  if (this._inflightEvents.size === 0) {
    this._apmClient.flush({ lambdaEnd }, boundCb);
    return;
  }

  // Otherwise, there are inflight events to wait for.  Setup a handler to
  // callback when the current set of inflight events complete.
  const flushingInflightEvents = this._inflightEvents;
  flushingInflightEvents.setDrainHandler((drainErr) => {
    // The only possible drainErr is a timeout. This is best effort, so we only
    // log this and move on.
    this.logger.debug(
      {
        numRemainingInflightEvents: flushingInflightEvents.size,
        err: drainErr,
      },
      'flush: drained inflight events',
    );

    // Then, flush the intake request to APM server.
    this._apmClient.flush({ lambdaEnd }, boundCb);
  }, opts.inflightTimeoutMs);

  // Create a new empty set to collect subsequent inflight events.
  this._inflightEvents = new InflightEventSet();
};

Agent.prototype.registerMetric = function (name, labelsOrCallback, callback) {
  var labels;
  if (typeof labelsOrCallback === 'function') {
    callback = labelsOrCallback;
  } else {
    labels = labelsOrCallback;
  }

  if (typeof callback !== 'function') {
    this.logger.error("Can't add callback of type %s", typeof callback);
    return;
  }

  this._metrics.getOrCreateGauge(name, callback, labels);
};

/**
 * Return true iff the given metric name is "disabled", according to the
 * `disableMetrics` config var.
 *
 * @returns {boolean}
 */
Agent.prototype._isMetricNameDisabled = function (name) {
  const regexps = this._conf.disableMetricsRegExp;
  for (var i = 0; i < regexps.length; i++) {
    if (regexps[i].test(name)) {
      return true;
    }
  }
  return false;
};
