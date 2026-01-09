'use strict';

const { URL } = require('url');

const { WildcardMatcher } = require('../wildcard-matcher');
const {
  TRACE_CONTINUATION_STRATEGY_CONTINUE,
  TRACE_CONTINUATION_STRATEGY_RESTART,
  TRACE_CONTINUATION_STRATEGY_RESTART_EXTERNAL,
  CONTEXT_MANAGER_ASYNCHOOKS,
  CONTEXT_MANAGER_ASYNCLOCALSTORAGE,
} = require('../constants');

/**
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as key/value pair
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeKeyValuePairs(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (key in opts) {
      if (typeof opts[key] === 'object' && !Array.isArray(opts[key])) {
        opts[key] = Object.entries(opts[key]);
        continue;
      }

      if (!Array.isArray(opts[key]) && typeof opts[key] === 'string') {
        opts[key] = opts[key].split(',').map((v) => v.trim());
      }

      if (Array.isArray(opts[key])) {
        // Note: Currently this assumes no '=' in the value. Also this does not
        // trim whitespace.
        opts[key] = opts[key].map((value) =>
          typeof value === 'string' ? value.split('=') : value,
        );
      }
    }
  }
}

/**
 * Normalizes the number properties of the config options object
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as number
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeNumbers(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (key in opts) opts[key] = Number(opts[key]);
  }
}

/**
 * Normalizes the number properties of the config options object
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as number
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeInfinity(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (opts[key] === -1) opts[key] = Infinity;
  }
}

/**
 * Translates a string byte size, e.g. '10kb', into an integer number of bytes.
 *
 * @param {String} input
 * @param {string} key - the config option key
 * @param {import('../logging.js').Logger} logger
 * @returns {Number|undefined}
 */
function bytes(input, key, logger) {
  const matches = input.match(/^(\d+)(b|kb|mb|gb)$/i);
  if (!matches) {
    logger.warn(
      'units missing in size value "%s" for "%s" config option. Use one of b|kb|mb|gb',
      input,
      key,
    );
    return Number(input);
  }

  const suffix = matches[2].toLowerCase();
  let value = Number(matches[1]);

  if (!suffix || suffix === 'b') {
    return value;
  }

  value *= 1024;
  if (suffix === 'kb') {
    return value;
  }

  value *= 1024;
  if (suffix === 'mb') {
    return value;
  }

  value *= 1024;
  if (suffix === 'gb') {
    return value;
  }
}

/**
 * Normalizes the byte properties of the config options object
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as bytes
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeBytes(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (key in opts) {
      opts[key] = bytes(String(opts[key]), key, logger);
      if (key === 'errorMessageMaxLength') {
        logger.warn(
          'config option "errorMessageMaxLength" is deprecated. Use "longFieldMaxLength"',
        );
      }
    }
  }
}

/**
 *
 * @param {String|Number} duration - Typically a string of the form `<num><unit>`,
 *    for example `30s`, `-1ms`, `2m`. The `defaultUnit` is used if a unit is
 *    not part of the string, or if duration is a number. If given as a string,
 *    decimal ('1.5s') and exponential-notation ('1e-3s') values are not allowed.
 * @param {String} defaultUnit
 * @param {Array<String>} allowedUnits - An array of the allowed unit strings. This
 *    array may include any number of `us`, `ms`, `s`, and `m`.
 * @param {Boolean} allowNegative - Whether a negative number is allowed.
 * @param {string} key - the config option key
 * @param {Logger} logger
 * @returns {number|null}
 */
function secondsFromDuration(
  duration,
  defaultUnit,
  allowedUnits,
  allowNegative,
  key,
  logger,
) {
  let val;
  let unit;
  if (typeof duration === 'string') {
    let match;
    if (allowNegative) {
      match = /^(-?\d+)(\w+)?$/.exec(duration);
    } else {
      match = /^(\d+)(\w+)?$/.exec(duration);
    }
    if (!match) {
      return null;
    }
    val = Number(match[1]);
    if (isNaN(val) || !Number.isFinite(val)) {
      return null;
    }
    unit = match[2];
    if (!unit) {
      logger.warn(
        'units missing in duration value "%s" for "%s" config option: using default units "%s"',
        duration,
        key,
        defaultUnit,
      );
      unit = defaultUnit;
    }
    if (!allowedUnits.includes(unit)) {
      return null;
    }
  } else if (typeof duration === 'number') {
    if (isNaN(duration)) {
      return null;
    } else if (duration < 0 && !allowNegative) {
      return null;
    }
    val = duration;
    unit = defaultUnit;
  } else {
    return null;
  }

  // Scale to seconds.
  switch (unit) {
    case 'us':
      val /= 1e6;
      break;
    case 'ms':
      val /= 1e3;
      break;
    case 's':
      break;
    case 'm':
      val *= 60;
      break;
    default:
      throw new Error(`unknown unit "${unit}" from "${duration}"`);
  }

  return val;
}

/**
 * Normalizes the duration properties of the config options object
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {Array<Object>} fields the list of fields to normalize as duration (with name, defaultUnit, allowedUnits, allowNegative)
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeDurationOptions(opts, fields, defaults, logger) {
  for (const optSpec of fields) {
    const key = optSpec.name;
    if (key in opts) {
      const val = secondsFromDuration(
        opts[key],
        optSpec.defaultUnit,
        optSpec.allowedUnits,
        optSpec.allowNegative,
        key,
        logger,
      );
      if (val === null) {
        if (key in defaults) {
          const def = defaults[key];
          logger.warn(
            'invalid duration value "%s" for "%s" config option: using default "%s"',
            opts[key],
            key,
            def,
          );
          opts[key] = secondsFromDuration(
            def,
            optSpec.defaultUnit,
            optSpec.allowedUnits,
            optSpec.allowNegative,
            key,
            logger,
          );
        } else {
          logger.warn(
            'invalid duration value "%s" for "%s" config option: ignoring this option',
            opts[key],
            key,
          );
          delete opts[key];
        }
      } else {
        opts[key] = val;
      }
    }
  }
}

/**
 * Normalizes the array properties of the config options object
 * Array config vars are either already an array of strings, or a
 * comma-separated string (whitespace is trimmed):
 *    'foo, bar' => ['foo', 'bar']
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as arrays
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeArrays(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (key in opts && typeof opts[key] === 'string') {
      opts[key] = opts[key].split(',').map((v) => v.trim());
    }
  }
}

/**
 * Parses "true"|"false" to boolean if not a boolean already and returns it. Returns undefined otherwise
 *
 * @param {import('../logging.js').Logger} logger
 * @param {String} key
 * @param {any} value
 * @returns {Boolean|undefined}
 */
function strictBool(logger, key, value) {
  if (typeof value === 'boolean') {
    return value;
  }
  // This will return undefined for unknown inputs, resulting in them being skipped.
  switch (value) {
    case 'false':
      return false;
    case 'true':
      return true;
    default: {
      logger.warn('unrecognized boolean value "%s" for "%s"', value, key);
    }
  }
}

/**
 * Normalizes the boolean properties of the config options object
 * Boolean config vars are either already a boolean, or a string
 * representation of the boolean value: `true` or `false`
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as boolean
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeBools(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (key in opts) opts[key] = strictBool(logger, key, opts[key]);
  }
}

/**
 * Checks validity of the URL properties of the config options object.
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as boolean
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeUrls(opts, fields, defaults, logger) {
  for (const key of fields) {
    if (key in opts) {
      try {
        // eslint-disable-next-line no-unused-vars
        const url = new URL(opts[key]);
      } catch (err) {
        logger.warn('Invalid "%s" config value, it must be a valid URL', key);
        opts[key] = null;
      }
    }
  }
}

/**
 * Normalizes the ignore options and places them in specific properties for string and RegExp values
 *
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as boolean
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeIgnoreOptions(opts, fields, defaults, logger) {
  // Params are meant to be used in upcoming changes
  if (opts.transactionIgnoreUrls) {
    opts.transactionIgnoreUrlRegExp = [];
    const wildcard = new WildcardMatcher();
    for (const ptn of opts.transactionIgnoreUrls) {
      const re = wildcard.compile(ptn);
      opts.transactionIgnoreUrlRegExp.push(re);
    }
  }

  if (opts.ignoreUrls) {
    opts.ignoreUrlStr = [];
    opts.ignoreUrlRegExp = [];
    for (const ptn of opts.ignoreUrls) {
      if (typeof ptn === 'string') {
        opts.ignoreUrlStr.push(ptn);
      } else {
        opts.ignoreUrlRegExp.push(ptn);
      }
    }
    delete opts.ignoreUrls;
  }

  if (opts.ignoreUserAgents) {
    opts.ignoreUserAgentStr = [];
    opts.ignoreUserAgentRegExp = [];
    for (const ptn of opts.ignoreUserAgents) {
      if (typeof ptn === 'string') {
        opts.ignoreUserAgentStr.push(ptn);
      } else {
        opts.ignoreUserAgentRegExp.push(ptn);
      }
    }
    delete opts.ignoreUserAgents;
  }

  if (opts.ignoreMessageQueues) {
    opts.ignoreMessageQueuesRegExp = [];
    const wildcard = new WildcardMatcher();
    for (const ptn of opts.ignoreMessageQueues) {
      const re = wildcard.compile(ptn);
      opts.ignoreMessageQueuesRegExp.push(re);
    }
  }
}

/**
 * Normalizes the wildcard matchers of sanitizeFieldNames and thansforms the into RegExps
 *
 * TODO: we are doing the same to some ignoreOptions
 * @param {Record<String, unknown>} opts the configuration options to normalize
 */
function normalizeSanitizeFieldNames(opts) {
  if (opts.sanitizeFieldNames) {
    opts.sanitizeFieldNamesRegExp = [];
    const wildcard = new WildcardMatcher();
    for (const ptn of opts.sanitizeFieldNames) {
      const re = wildcard.compile(ptn);
      opts.sanitizeFieldNamesRegExp.push(re);
    }
  }
}

// TODO: this is the same as normalizeSanitizeFieldNames
// maybe create a normalizeWildcardOptions???
function normalizeDisableMetrics(opts) {
  if (opts.disableMetrics) {
    opts.disableMetricsRegExp = []; // This line was not in the original code but raised an exception in the tests
    const wildcard = new WildcardMatcher();
    for (const ptn of opts.disableMetrics) {
      const re = wildcard.compile(ptn);
      opts.disableMetricsRegExp.push(re);
    }
  }
}

// TODO: same as above
function normalizeElasticsearchCaptureBodyUrls(opts) {
  if (opts.elasticsearchCaptureBodyUrls) {
    opts.elasticsearchCaptureBodyUrlsRegExp = [];
    const wildcard = new WildcardMatcher();
    for (const ptn of opts.elasticsearchCaptureBodyUrls) {
      const re = wildcard.compile(ptn);
      opts.elasticsearchCaptureBodyUrlsRegExp.push(re);
    }
  }
}

/**
 * Makes sure the cloudProvider options is valid othherwise it set the default value.
 *
 * @param {Record<String, unknown>} opts the configuration options to normalize
 * @param {String[]} fields the list of fields to normalize as duration
 * @param {Record<String, unknown>} defaults the configuration defaults
 * @param {import('../logging.js').Logger} logger
 */
function normalizeCloudProvider(opts, fields, defaults, logger) {
  if ('cloudProvider' in opts) {
    const allowedValues = ['auto', 'gcp', 'azure', 'aws', 'none'];
    if (allowedValues.indexOf(opts.cloudProvider) === -1) {
      logger.warn(
        'Invalid "cloudProvider" config value %s, falling back to default %s',
        opts.cloudProvider,
        defaults.cloudProvider,
      );
      opts.cloudProvider = defaults.cloudProvider;
    }
  }
}

// `customMetricsHistogramBoundaries` must be a sorted array of numbers,
// without duplicates.
function normalizeCustomMetricsHistogramBoundaries(
  opts,
  fields,
  defaults,
  logger,
) {
  if (!('customMetricsHistogramBoundaries' in opts)) {
    return;
  }
  let val = opts.customMetricsHistogramBoundaries;
  if (typeof val === 'string') {
    val = val.split(',').map((v) => Number(v.trim()));
  }
  let errReason = null;
  if (!Array.isArray(val)) {
    errReason = 'value is not an array';
  } else if (val.some((el) => typeof el !== 'number' || isNaN(el))) {
    errReason = 'array includes non-numbers';
  } else {
    for (let i = 0; i < val.length - 1; i++) {
      if (val[i] === val[i + 1]) {
        errReason = 'array has duplicate values';
        break;
      } else if (val[i] > val[i + 1]) {
        errReason = 'array is not sorted';
        break;
      }
    }
  }
  if (errReason) {
    logger.warn(
      'Invalid "customMetricsHistogramBoundaries" config value %j, %s; falling back to default',
      opts.customMetricsHistogramBoundaries,
      errReason,
    );
    opts.customMetricsHistogramBoundaries =
      defaults.customMetricsHistogramBoundaries;
  } else {
    opts.customMetricsHistogramBoundaries = val;
  }
}


function normalizeTransactionSampleRate(opts, fields, defaults, logger) {
  if ('transactionSampleRate' in opts) {
    // The value was already run through `Number(...)` in `normalizeNumbers`.
    const rate = opts.transactionSampleRate;
    if (isNaN(rate) || rate < 0 || rate > 1) {
      opts.transactionSampleRate = defaults.transactionSampleRate;
      logger.warn(
        'Invalid "transactionSampleRate" config value %s, falling back to default %s',
        rate,
        opts.transactionSampleRate,
      );
    } else if (rate > 0 && rate < 0.0001) {
      opts.transactionSampleRate = 0.0001;
    } else {
      opts.transactionSampleRate = Math.round(rate * 10000) / 10000;
    }
  }
}

const ALLOWED_TRACE_CONTINUATION_STRATEGY = {
  [TRACE_CONTINUATION_STRATEGY_CONTINUE]: true,
  [TRACE_CONTINUATION_STRATEGY_RESTART]: true,
  [TRACE_CONTINUATION_STRATEGY_RESTART_EXTERNAL]: true,
};
function normalizeTraceContinuationStrategy(opts, fields, defaults, logger) {
  if (
    'traceContinuationStrategy' in opts &&
    !(opts.traceContinuationStrategy in ALLOWED_TRACE_CONTINUATION_STRATEGY)
  ) {
    logger.warn(
      'Invalid "traceContinuationStrategy" config value %j, falling back to default %j',
      opts.traceContinuationStrategy,
      defaults.traceContinuationStrategy,
    );
    opts.traceContinuationStrategy = defaults.traceContinuationStrategy;
  }
}

const ALLOWED_CONTEXT_MANAGER = {
  [CONTEXT_MANAGER_ASYNCHOOKS]: true,
  [CONTEXT_MANAGER_ASYNCLOCALSTORAGE]: true,
};

/**
 * Normalize and validate the given values for `contextManager`, and the
 */
function normalizeContextManager(opts, fields, defaults, logger) {
  // Treat the empty string, e.g. `MTN_APM_CONTEXT_MANAGER=`, as if it had
  // not been specified.
  if (opts.contextManager === '') {
    delete opts.contextManager;
  }

  if (
    'contextManager' in opts &&
    !(opts.contextManager in ALLOWED_CONTEXT_MANAGER)
  ) {
    logger.warn(
      'Invalid "contextManager" config value %j, falling back to default behavior',
      opts.contextManager,
    );
    delete opts.contextManager;
  }
}
function normalizeSpanStackTraceMinDuration(opts, fields, defaults, logger) {
  const before = {};
  if (opts.captureSpanStackTraces !== undefined)
    before.captureSpanStackTraces = opts.captureSpanStackTraces;
  if (opts.spanFramesMinDuration !== undefined)
    before.spanFramesMinDuration = opts.spanFramesMinDuration;
  if (opts.spanStackTraceMinDuration !== undefined)
    before.spanStackTraceMinDuration = opts.spanStackTraceMinDuration;

  if ('spanStackTraceMinDuration' in opts) {
    // If the new option was specified, then use it and ignore the old two.
  } else if (opts.captureSpanStackTraces === false) {
    opts.spanStackTraceMinDuration = -1; // Turn off span stacktraces.
  } else if ('spanFramesMinDuration' in opts) {
    if (opts.spanFramesMinDuration === 0) {
      opts.spanStackTraceMinDuration = -1; // Turn off span stacktraces.
    } else if (opts.spanFramesMinDuration < 0) {
      opts.spanStackTraceMinDuration = 0; // Stacktraces for all spans.
    } else {
      opts.spanStackTraceMinDuration = opts.spanFramesMinDuration;
    }
  } else if (opts.captureSpanStackTraces === true) {
    // For backwards compat, use the default `spanFramesMinDuration` value
    // from before `spanStackTraceMinDuration` was introduced.
    opts.spanStackTraceMinDuration = 10 / 1e3; // 10ms
  } else {
    // None of the three options was specified.
    opts.spanStackTraceMinDuration = -1; // Turn off span stacktraces.
  }
  delete opts.captureSpanStackTraces;
  delete opts.spanFramesMinDuration;

  // Log if something potentially interesting happened here.
  if (Object.keys(before).length > 0) {
    const after = { spanStackTraceMinDuration: opts.spanStackTraceMinDuration };
    logger.trace({ before, after }, 'normalizeSpanStackTraceMinDuration');
  }
}

module.exports = {
  normalizeArrays,
  normalizeBools,
  normalizeBytes,
  normalizeCloudProvider,
  normalizeCustomMetricsHistogramBoundaries,
  normalizeDisableMetrics,
  normalizeDurationOptions,
  normalizeElasticsearchCaptureBodyUrls,
  normalizeIgnoreOptions,
  normalizeInfinity,
  normalizeKeyValuePairs,
  normalizeNumbers,
  normalizeSanitizeFieldNames,
  normalizeTransactionSampleRate,
  secondsFromDuration,
  normalizeTraceContinuationStrategy,
  normalizeContextManager,
  normalizeSpanStackTraceMinDuration,
  normalizeUrls,
};
