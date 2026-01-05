'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const AGENT_VERSION = require('../../package.json').version;
const { REDACTED } = require('../constants');

/**
 * @typedef {Object} OptionDefinition
 * @property {string} name the name of the configuration option
 * @property {keyof TypeNormalizers} configType the type of the configuration option
 * @property {any} defaultValue the default value of the property or undefined
 * @property {any} [environmentValue] defined if value is provided via environment var
 * @property {any} [startValue] defined if value is provided via `Agent.start()` API
 * @property {any} [fileValue] defined if value is provided via config file
 * @property {'environment' | 'start' | 'file'} [source] defined value comes from any source keeping its priorities (env, star, file, default)
 * @property {string} [envVar] the name of the environment varaiable associated with the option
 * @property {string} [envDeprecatedVar] the name of the deprecated environment varaiable associated with the option
 * @property {string} [centralConfigName] name of option in central configuration
 * @property {string} [crossAgentName] name of the same option in other agents
 * @property {(v: any) => any} [redactFn] if passed the value will be redacted with it on serialization (preamble...)
 */

/**
 * @type Array<OptionDefinition>
 */
const CONFIG_SCHEMA = [
  {
    name: 'abortedErrorThreshold',
    configType: 'durationSeconds',
    defaultValue: '25s',
    envVar: 'MTN_APM_ABORTED_ERROR_THRESHOLD',
  },
  {
    name: 'active',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_ACTIVE',
  },
  {
    name: 'addPatch',
    configType: 'stringKeyValuePairs',
    defaultValue: undefined,
    envVar: 'MTN_APM_ADD_PATCH',
  },
  {
    name: 'apiRequestSize',
    configType: 'byte',
    defaultValue: '768kb',
    envVar: 'MTN_APM_API_REQUEST_SIZE',
  },
  {
    name: 'apiRequestTime',
    configType: 'durationSeconds',
    defaultValue: '10s',
    envVar: 'MTN_APM_API_REQUEST_TIME',
  },
  {
    name: 'breakdownMetrics',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_BREAKDOWN_METRICS',
  },
  {
    name: 'captureBody',
    configType: 'select(off,all,errors,transactions)',
    defaultValue: 'off',
    envVar: 'MTN_APM_CAPTURE_BODY',
    centralConfigName: 'capture_body',
    crossAgentName: 'capture_body',
  },
  {
    name: 'captureErrorLogStackTraces',
    configType: 'select(messages,always)',
    defaultValue: 'messages',
    envVar: 'MTN_APM_CAPTURE_ERROR_LOG_STACK_TRACES',
  },
  {
    name: 'captureExceptions',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_CAPTURE_EXCEPTIONS',
  },
  {
    name: 'captureHeaders',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_CAPTURE_HEADERS',
  },
  {
    name: 'centralConfig',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_CENTRAL_CONFIG',
  },
  {
    name: 'cloudProvider',
    configType: 'select(auto,gcp,azure,aws,none)',
    defaultValue: 'auto',
    envVar: 'MTN_APM_CLOUD_PROVIDER',
  },
  {
    name: 'containerId',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_CONTAINER_ID',
  },
  {
    name: 'contextPropagationOnly',
    configType: 'boolean',
    defaultValue: false,
    envVar: 'MTN_APM_CONTEXT_PROPAGATION_ONLY',
  },
  {
    name: 'customMetricsHistogramBoundaries',
    configType: 'sortedNumberArray',
    defaultValue: [
      0.00390625, 0.00552427, 0.0078125, 0.0110485, 0.015625, 0.0220971,
      0.03125, 0.0441942, 0.0625, 0.0883883, 0.125, 0.176777, 0.25, 0.353553,
      0.5, 0.707107, 1, 1.41421, 2, 2.82843, 4, 5.65685, 8, 11.3137, 16,
      22.6274, 32, 45.2548, 64, 90.5097, 128, 181.019, 256, 362.039, 512,
      724.077, 1024, 1448.15, 2048, 2896.31, 4096, 5792.62, 8192, 11585.2,
      16384, 23170.5, 32768, 46341, 65536, 92681.9, 131072,
    ],
    envVar: 'MTN_APM_CUSTOM_METRICS_HISTOGRAM_BOUNDARIES',
  },
  {
    name: 'disableInstrumentations',
    configType: 'stringArray',
    defaultValue: [],
    envVar: 'MTN_APM_DISABLE_INSTRUMENTATIONS',
  },
  {
    name: 'disableMetrics',
    configType: 'stringArray',
    defaultValue: [],
    envVar: 'MTN_APM_DISABLE_METRICS',
  },
  {
    name: 'disableMetricsRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['disableMetrics'],
  },
  {
    name: 'disableSend',
    configType: 'boolean',
    defaultValue: false,
    envVar: 'MTN_APM_DISABLE_SEND',
  },
  {
    name: 'elasticsearchCaptureBodyUrls',
    configType: 'stringArray',
    defaultValue: [
      '*/_search',
      '*/_search/template',
      '*/_msearch',
      '*/_msearch/template',
      '*/_async_search',
      '*/_count',
      '*/_sql',
      '*/_eql/search',
    ],
    envVar: 'MTN_APM_ELASTICSEARCH_CAPTURE_BODY_URLS',
  },
  {
    name: 'elasticsearchCaptureBodyUrlsRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['elasticsearchCaptureBodyUrls'],
  },
  {
    name: 'environment',
    configType: 'string',
    defaultValue: process.env.NODE_ENV || 'development',
    envVar: 'MTN_APM_ENVIRONMENT',
  },
  {
    name: 'errorOnAbortedRequests',
    configType: 'boolean',
    defaultValue: false,
    envVar: 'MTN_APM_ERROR_ON_ABORTED_REQUESTS',
  },
  {
    name: 'exitSpanMinDuration',
    configType: 'durationMilliseconds',
    defaultValue: '0ms',
    envVar: 'MTN_APM_EXIT_SPAN_MIN_DURATION',
    centralConfigName: 'exit_span_min_duration',
    crossAgentName: 'exit_span_min_duration',
  },
  {
    name: 'globalLabels',
    configType: 'stringKeyValuePairs',
    defaultValue: undefined,
    envVar: 'MTN_APM_GLOBAL_LABELS',
  },
  {
    name: 'ignoreMessageQueues',
    configType: 'stringArray',
    defaultValue: [],
    envVar: 'MTN_APM_IGNORE_MESSAGE_QUEUES',
    centralConfigName: 'ignore_message_queues',
    crossAgentName: 'ignore_message_queues',
  },
  {
    name: 'ignoreMessageQueuesRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['ignoreMessageQueues'],
  },
  {
    name: 'instrument',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_INSTRUMENT',
  },
  {
    name: 'instrumentIncomingHTTPRequests',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_INSTRUMENT_INCOMING_HTTP_REQUESTS',
  },
  {
    name: 'kubernetesNamespace',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'KUBERNETES_NAMESPACE',
  },
  {
    name: 'kubernetesNodeName',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'KUBERNETES_NODE_NAME',
  },
  {
    name: 'kubernetesPodName',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'KUBERNETES_POD_NAME',
  },
  {
    name: 'kubernetesPodUID',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'KUBERNETES_POD_UID',
  },
  {
    name: 'logLevel',
    configType: 'select(debug,info,warning,error,critical,off,trace)',
    defaultValue: 'info',
    envVar: 'MTN_APM_LOG_LEVEL',
    centralConfigName: 'log_level',
    crossAgentName: 'log_level',
  },
  {
    name: 'longFieldMaxLength',
    configType: 'number',
    defaultValue: 10000,
    envVar: 'MTN_APM_LONG_FIELD_MAX_LENGTH',
  },
  {
    name: 'maxQueueSize',
    configType: 'number',
    defaultValue: 1024,
    envVar: 'MTN_APM_MAX_QUEUE_SIZE',
  },
  {
    name: 'metricsInterval',
    configType: 'durationSeconds',
    defaultValue: '30s',
    envVar: 'MTN_APM_METRICS_INTERVAL',
  },
  {
    name: 'metricsLimit',
    configType: 'number',
    defaultValue: 1000,
    envVar: 'MTN_APM_METRICS_LIMIT',
  },
  {
    name: 'opentelemetryBridgeEnabled',
    configType: 'boolean',
    defaultValue: false,
    envVar: 'MTN_APM_OPENTELEMETRY_BRIDGE_ENABLED',
  },
  {
    name: 'sanitizeFieldNames',
    configType: 'stringArray',
    defaultValue: [
      'password',
      'passwd',
      'pwd',
      'secret',
      '*key',
      '*token*',
      '*session*',
      '*credit*',
      '*card*',
      '*auth*',
      'set-cookie',
      '*principal*',
      // These are default patterns only in the Node.js APM agent, historically
      // from when the "is-secret" dependency was used.
      'pw',
      'pass',
      'connect.sid',
      // Additional ones added to the Node.js APM agent.
      'cookie', // The "Cookie" HTTP request header is often sensitive.
    ],
    envVar: 'MTN_APM_SANITIZE_FIELD_NAMES',
    centralConfigName: 'sanitize_field_names',
    crossAgentName: 'sanitize_field_names',
  },
  {
    name: 'sanitizeFieldNamesRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['sanitizeFieldNames'],
  },
  {
    name: 'serviceNodeName',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_SERVICE_NODE_NAME',
  },
  {
    name: 'serverTimeout',
    configType: 'durationSeconds',
    defaultValue: '30s',
    envVar: 'MTN_APM_SERVER_TIMEOUT',
  },
  {
    name: 'serverUrl',
    configType: 'url',
    defaultValue: 'http://127.0.0.1:8200',
    envVar: 'MTN_APM_SERVER_URL',
    crossAgentName: 'server_url',
    redactFn: sanitizeUrl,
  },
  {
    name: 'sourceLinesErrorAppFrames',
    configType: 'number',
    defaultValue: 5,
    envVar: 'MTN_APM_SOURCE_LINES_ERROR_APP_FRAMES',
  },
  {
    name: 'sourceLinesErrorLibraryFrames',
    configType: 'number',
    defaultValue: 5,
    envVar: 'MTN_APM_SOURCE_LINES_ERROR_LIBRARY_FRAMES',
  },
  {
    name: 'sourceLinesSpanAppFrames',
    configType: 'number',
    defaultValue: 0,
    envVar: 'MTN_APM_SOURCE_LINES_SPAN_APP_FRAMES',
  },
  {
    name: 'sourceLinesSpanLibraryFrames',
    configType: 'number',
    defaultValue: 0,
    envVar: 'MTN_APM_SOURCE_LINES_SPAN_LIBRARY_FRAMES',
  },
  {
    name: 'spanCompressionEnabled',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_SPAN_COMPRESSION_ENABLED',
  },
  {
    name: 'spanCompressionExactMatchMaxDuration',
    configType: 'durationCompression',
    defaultValue: '50ms',
    envVar: 'MTN_APM_SPAN_COMPRESSION_EXACT_MATCH_MAX_DURATION',
  },
  {
    name: 'spanCompressionSameKindMaxDuration',
    configType: 'durationCompression',
    defaultValue: '0ms',
    envVar: 'MTN_APM_SPAN_COMPRESSION_SAME_KIND_MAX_DURATION',
  },
  {
    name: 'stackTraceLimit',
    configType: 'number',
    defaultValue: 50,
    envVar: 'MTN_APM_STACK_TRACE_LIMIT',
  },
  {
    name: 'traceContinuationStrategy',
    configType: 'select(continue,restart,external)',
    defaultValue: 'continue',
    envVar: 'MTN_APM_TRACE_CONTINUATION_STRATEGY',
    centralConfigName: 'trace_continuation_strategy',
    crossAgentName: 'trace_continuation_strategy',
  },
  {
    name: 'transactionIgnoreUrls',
    configType: 'stringArray',
    defaultValue: [],
    envVar: 'MTN_APM_TRANSACTION_IGNORE_URLS',
    centralConfigName: 'transaction_ignore_urls',
    crossAgentName: 'transaction_ignore_urls',
  },
  {
    name: 'transactionIgnoreUrlRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['transactionIgnoreUrls'],
  },
  {
    name: 'transactionMaxSpans',
    configType: 'numberInfinity',
    defaultValue: 500,
    envVar: 'MTN_APM_TRANSACTION_MAX_SPANS',
    centralConfigName: 'transaction_max_spans',
    crossAgentName: 'transaction_max_spans',
  },
  {
    name: 'transactionSampleRate',
    configType: 'sampleRate',
    defaultValue: 1,
    envVar: 'MTN_APM_TRANSACTION_SAMPLE_RATE',
    centralConfigName: 'transaction_sample_rate',
    crossAgentName: 'transaction_sample_rate',
  },
  {
    name: 'useElasticTraceparentHeader',
    configType: 'boolean',
    defaultValue: false,
    envVar: 'MTN_APM_USE_ELASTIC_TRACEPARENT_HEADER',
  },
  {
    name: 'usePathAsTransactionName',
    configType: 'boolean',
    defaultValue: false,
    envVar: 'MTN_APM_USE_PATH_AS_TRANSACTION_NAME',
  },
  {
    name: 'verifyServerCert',
    configType: 'boolean',
    defaultValue: true,
    envVar: 'MTN_APM_VERIFY_SERVER_CERT',
  },
  {
    name: 'errorMessageMaxLength',
    configType: 'byte',
    defaultValue: undefined,
    envVar: 'MTN_APM_ERROR_MESSAGE_MAX_LENGTH',
    deprecated: 'Deprecated in: v3.21.0, use longFieldMaxLength',
  },
  {
    name: 'spanStackTraceMinDuration',
    configType: 'durationMillisecondsNegative',
    // 'spanStackTraceMinDuration' is explicitly *not* defined in DEFAULTS
    // because normalizeSpanStackTraceMinDuration() needs to know if a value
    // was provided by the user.
    defaultValue: undefined,
    envVar: 'MTN_APM_SPAN_STACK_TRACE_MIN_DURATION',
    centralConfigName: 'span_stack_trace_min_duration',
    crossAgentName: 'span_stack_trace_min_duration',
  },
  {
    name: 'apiKey',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_API_KEY',
    crossAgentName: 'api_key',
    redactFn: () => REDACTED,
  },
  {
    name: 'captureSpanStackTraces',
    configType: 'boolean',
    defaultValue: undefined,
    envVar: 'MTN_APM_CAPTURE_SPAN_STACK_TRACES',
    deprecated: 'Deprecated in: v3.30.0, use spanStackTraceMinDuration',
  },
  {
    name: 'contextManager',
    configType: 'select(asynclocalstorage,asynchooks)',
    // 'contextManager' is explicitly *not* defined in DEFAULTS because
    // normalizeContextManager() needs to know if a value was provided by the
    // user.
    defaultValue: undefined,
    envVar: 'MTN_APM_CONTEXT_MANAGER',
  },
  {
    name: 'frameworkName',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_FRAMEWORK_NAME',
  },
  {
    name: 'frameworkVersion',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_FRAMEWORK_VERSION',
  },
  {
    name: 'hostname',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_HOSTNAME',
  },
  {
    name: 'payloadLogFile',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_PAYLOAD_LOG_FILE',
  },
  {
    name: 'serverCaCertFile',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_SERVER_CA_CERT_FILE',
  },
  {
    name: 'secretToken',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_SECRET_TOKEN',
    crossAgentName: 'secret_token',
    redactFn: () => REDACTED,
  },
  {
    name: 'serviceName',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_SERVICE_NAME',
    crossAgentName: 'service_name',
  },
  {
    name: 'serviceVersion',
    configType: 'string',
    defaultValue: undefined,
    envVar: 'MTN_APM_SERVICE_VERSION',
    crossAgentName: 'service_version',
  },
  {
    name: 'spanFramesMinDuration',
    configType: 'durationSecondsNegative',
    defaultValue: undefined,
    envVar: 'MTN_APM_SPAN_FRAMES_MIN_DURATION',
    deprecated: 'Deprecated in: v3.30.0, use spanStackTraceMinDuration',
  },
  { name: 'ignoreUrls', configType: 'stringArray', defaultValue: undefined },
  {
    name: 'ignoreUrlRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['ignoreUrls'],
  },
  {
    name: 'ignoreUrlStr',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['ignoreUrls'],
  },
  {
    name: 'ignoreUserAgents',
    configType: 'stringArray',
    defaultValue: undefined,
  },
  {
    name: 'ignoreUserAgentRegExp',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['ignoreUserAgents'],
  },
  {
    name: 'ignoreUserAgentStr',
    configType: 'wildcardArray',
    defaultValue: [],
    deps: ['ignoreUserAgents'],
  },
  {
    name: 'apmClientHeaders',
    configType: 'stringKeyValuePairs',
    defaultValue: undefined,
    envVar: 'MTN_APM_APM_CLIENT_HEADERS',
  },
  // Special options that
  // - may afect the whole config
  // - change the behavior of thelogger
  // - are for testing or internal use
  {
    name: 'configFile',
    configType: 'string',
    defaultValue: 'mtn-apm-agent.js',
    envVar: 'MTN_APM_CONFIG_FILE',
  },
  {
    name: 'logger',
    configType: 'logger',
    defaultValue: undefined,
    envVar: 'MTN_APM_LOGGER',
  },
  {
    name: 'transport',
    configType: 'function',
    defaultValue: undefined,
    internal: true,
  },
];

/**
 * Retuns an object with th default values for all config options
 * @returns {Record<string,any>}
 */
function getDefaultOptions() {
  return CONFIG_SCHEMA.reduce((acc, def) => {
    if (typeof def.defaultValue !== 'undefined') {
      acc[def.name] = def.defaultValue;
    }
    return acc;
  }, {});
}

/**
 * Retuns an object with the values of config options defined set
 * in the environment
 * @returns {Record<string,any>}
 */
function getEnvironmentOptions() {
  return CONFIG_SCHEMA.reduce((acc, def) => {
    if ('environmentValue' in def) {
      acc[def.name] = def.environmentValue;
    }
    return acc;
  }, {});
}

/**
 * Retuns an object with the values of config options defined set
 * in the environment
 * @returns {Record<string,any>}
 */
function getFileOptions() {
  return CONFIG_SCHEMA.reduce((acc, def) => {
    if ('fileValue' in def) {
      acc[def.name] = def.fileValue;
    }
    return acc;
  }, {});
}

function readEnvOptions() {
  CONFIG_SCHEMA.forEach((def) => {
    if (def.envVar && process.env[def.envVar]) {
      def.environmentValue = process.env[def.envVar];
      def.source = 'environment';
    } else if (def.envVar) {
      // TODO: this is necessary since config.test.js sets different vars during tests
      delete def.environmentValue;
      delete def.source;
    }
  });
}

/**
 * Tries to load a configuration file for the given path or from the ENV vars, if both undefined
 * it uses the default config filename `mtn-apm-agent.js`. If the config file is not present or
 * there is something wrong in the file it will return no options
 * @param {string} [confPath] the path to the file
 * @returns {Record<string,any> | null}
 */
function readFileOptions(confPath) {
  const configFileDef = CONFIG_SCHEMA.find((def) => def.name === 'configFile');
  const defaultValue = configFileDef.defaultValue;
  const envValue = process.env[configFileDef.envVar];
  const filePath = path.resolve(confPath || envValue || defaultValue);

  if (fs.existsSync(filePath)) {
    try {
      return require(filePath);
    } catch (err) {
      console.error(
        "MTN APM initialization error: Can't read config file %s",
        filePath,
      );
      console.error(err.stack);
    }
  }

  return null;
}

/**
 * Sets into the schema the value given at agent start
 *
 * @param {Record<string,any>} options
 */
function setStartOptions(options) {
  if (!options) {
    return;
  }

  const fileOpts = options.configFile && readFileOptions(options.configFile);

  CONFIG_SCHEMA.forEach((def) => {
    const source = def.source || 'default';

    if (def.name in options) {
      def.startValue = options[def.name];
      if (source !== 'environment') {
        def.source = 'start';
      }
    } else if (fileOpts && def.name in fileOpts) {
      // console.log('setting from file', def.name, fileOpts[def.name], source);
      def.fileValue = fileOpts[def.name];
      if (source === 'default') {
        def.source = 'file';
      }
      console.log(def);
    }
  });
}

/**
 * Collects information about the agent, environment and configuration options that are
 *
 * @param {Object} config The configuration object with normalized options
 * @returns {Object} Object with agent, environment, and configuration data.
 */
function getPreambleData(config) {
  const configFileDef = CONFIG_SCHEMA.find((def) => def.name === 'configFile');
  const configFilePath = path.resolve(
    configFileDef.environmentValue ||
      configFileDef.startValue ||
      configFileDef.defaultValue,
  );

  const result = {
    agentVersion: AGENT_VERSION,
    env: {
      pid: process.pid,
      proctitle: process.title,
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      host: os.hostname(),
      timezone: getTimezoneUtc(),
      runtime: `Node.js ${process.version}`,
    },
    config: {},
  };

  const excludedKeys = new Set(['logger', 'transport']);
  const mandatoryKeys = new Set([
    'serviceName',
    'serviceVersion',
    'serverUrl',
    'logLevel',
  ]);

  CONFIG_SCHEMA.forEach((def) => {
    if (
      excludedKeys.has(def.name) ||
      (!def.source && !mandatoryKeys.has(def.name))
    ) {
      return;
    }

    const details = {
      source: def.source || 'default',
      value: config[def.name],
    };

    const sourceVal = def[`${details.source}Value`];

    if (def.crossAgentName) {
      details.commonName = def.crossAgentName;
    }

    if (def.source === 'file') {
      details.file = configFilePath;
    }

    if (typeof def.redactFn === 'function') {
      details.value = def.redactFn(details.value);
    } else if (sourceVal !== details.value) {
      details.sourceValue = sourceVal;
    }

    result.config[def.name] = details;
  });

  return result;
}

/**
 * Returns the current Timezone in UTC notation fomat
 *
 * @returns {String} ex. UTC-0600
 */
function getTimezoneUtc() {
  const offsetHours = -(new Date().getTimezoneOffset() / 60);
  const offsetSign = offsetHours >= 0 ? '+' : '-';
  const offsetPad = Math.abs(offsetHours) < 10 ? '0' : '';
  return `UTC${offsetSign}${offsetPad}${Math.abs(offsetHours * 100)}`;
}

/**
 * Takes an URL string and redacts user & password info if present in the basic
 * auth part
 *
 * @param {String} urlStr The URL to strip sensitive info
 * @returns {String || null} url with basic auth REDACTED
 */
function sanitizeUrl(urlStr) {
  if (!urlStr) {
    return '';
  }

  const url = new URL(urlStr);
  if (url.username) {
    url.username = REDACTED;
  }
  if (url.password) {
    url.password = REDACTED;
  }

  return decodeURIComponent(url.href);
}

const depSet = new Set();
const fileOpts = readFileOptions();

CONFIG_SCHEMA.forEach((def) => {
  if (depSet.has(def.name)) {
    throw Error(`config option ${def.name} duplicated.`);
  }
  if (def.deps && def.deps.some((d) => !depSet.has(d))) {
    throw Error(
      `config option ${def.name} dependencies (${def.deps}) need to be defined before.`,
    );
  }
  depSet.add(def.name);

  // Initalize values comming from environment and config file
  if (def.envVar && process.env[def.envVar]) {
    def.environmentValue = process.env[def.envVar];
    def.source = 'environment';
  } else if (fileOpts && typeof fileOpts[def.name] !== 'undefined') {
    def.fileValue = fileOpts[def.name];
    def.source = 'file';
  }
});

// TODO: these constants below to be removed in the future (normalization)
function getConfigName(def) {
  return def.name;
}
function optsOfTypes(types) {
  if (!Array.isArray(types)) {
    types = [types];
  }
  return CONFIG_SCHEMA.filter((def) => types.indexOf(def.configType) !== -1);
}

const BOOL_OPTS = optsOfTypes('boolean').map(getConfigName);
const NUM_OPTS = optsOfTypes(['number', 'numberInfinity']).map(getConfigName);
const BYTES_OPTS = optsOfTypes('byte').map(getConfigName);
const URL_OPTS = optsOfTypes('url').map(getConfigName);
const ARRAY_OPTS = optsOfTypes('stringArray').map(getConfigName);
const KEY_VALUE_OPTS = optsOfTypes('stringKeyValuePairs').map(getConfigName);
const MINUS_ONE_EQUAL_INFINITY = optsOfTypes(['numberInfinity']).map(
  getConfigName,
);

const CENTRAL_CONFIG_OPTS = CONFIG_SCHEMA.filter(
  (def) => def.centralConfigName,
).reduce((acc, def) => {
  acc[def.centralConfigName] = def.name;
  return acc;
}, {});

const DURATION_OPTS = [
  {
    name: 'abortedErrorThreshold',
    defaultUnit: 's',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: false,
  },
  {
    name: 'apiRequestTime',
    defaultUnit: 's',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: false,
  },
  {
    name: 'exitSpanMinDuration',
    defaultUnit: 'ms',
    allowedUnits: ['us', 'ms', 's', 'm'],
    allowNegative: false,
  },
  {
    name: 'metricsInterval',
    defaultUnit: 's',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: false,
  },
  {
    name: 'serverTimeout',
    defaultUnit: 's',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: false,
  },
  {
    name: 'spanCompressionExactMatchMaxDuration',
    defaultUnit: 'ms',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: false,
  },
  {
    name: 'spanCompressionSameKindMaxDuration',
    defaultUnit: 'ms',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: false,
  },
  {
    // Deprecated: use `spanStackTraceMinDuration`.
    name: 'spanFramesMinDuration',
    defaultUnit: 's',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: true,
  },
  {
    name: 'spanStackTraceMinDuration',
    defaultUnit: 'ms',
    allowedUnits: ['ms', 's', 'm'],
    allowNegative: true,
  },
];
const CROSS_AGENT_CONFIG_VAR_NAME = CONFIG_SCHEMA.filter(
  (def) => def.crossAgentName,
).reduce((acc, def) => {
  acc[def.name] = def.crossAgentName;
  return acc;
}, {});

const ENV_TABLE = CONFIG_SCHEMA.filter((def) => def.envVar).reduce(
  (acc, def) => {
    acc[def.name] = def.envVar;
    return acc;
  },
  {},
);

// Exports
module.exports = {
  BOOL_OPTS,
  NUM_OPTS,
  DURATION_OPTS,
  BYTES_OPTS,
  MINUS_ONE_EQUAL_INFINITY,
  ARRAY_OPTS,
  KEY_VALUE_OPTS,
  URL_OPTS,
  CROSS_AGENT_CONFIG_VAR_NAME,
  CENTRAL_CONFIG_OPTS,
  ENV_TABLE,
  CONFIG_SCHEMA,
  getDefaultOptions,
  getEnvironmentOptions,
  getFileOptions,
  setStartOptions,
  getPreambleData,
  readEnvOptions,
};
