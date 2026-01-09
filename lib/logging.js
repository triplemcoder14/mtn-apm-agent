'use strict';

/**
 * @typedef {Object} Logger
 * @property {function(Record<string, any> | string, ...any): undefined} fatal
 * @property {function(Record<string, any> | string, ...any): undefined} error
 * @property {function(Record<string, any> | string, ...any): undefined} warn
 * @property {function(Record<string, any> | string, ...any): undefined} info
 * @property {function(Record<string, any> | string, ...any): undefined} debug
 * @property {function(Record<string, any> | string, ...any): undefined} trace
 */

const { ecsFormat } = require('@elastic/ecs-pino-format');
var pino = require('pino');
var semver = require('semver');
const { version: agentVersion } = require('../package.json');

const DEFAULT_LOG_LEVEL = 'info';

// used to mark loggers created here, for use by `isLoggerCustom()`.
const LOGGER_IS_OURS_SYM = Symbol('MTNAPMLoggerIsOurs');

const AGENT_METADATA = {
  agent: {
    name: 'mtn-apm-agent',
    maintainer: 'mtn-sre-team',
    coreMaintainer: 'muutassim.mukhtar@mtn.com',
    version: agentVersion,
  },
};

const PINO_LEVEL_FROM_LEVEL_NAME = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn', // Supported for backwards compat
  error: 'error',
  critical: 'fatal',
  fatal: 'fatal', // Supported for backwards compat
  off: 'silent',
};
class SafePinoDestWrapper {
  constructor(customLogger) {
    this.customLogger = customLogger;
    this.logFnNameFromLastLevel = pino.levels.labels;
    this[Symbol.for('pino.metadata')] = true;
  }

  write(s) {
    const { lastMsg, lastLevel } = this;
    const logFnName = this.logFnNameFromLastLevel[lastLevel];
    this.customLogger[logFnName](lastMsg);
  }
}

/**
 * Creates a pino logger for the agent.
 *
 * By default `createLogger()` will return a pino logger that logs to stdout
 * in ecs-logging format, set to the "info" level.
 *
 * @param {String} levelName - Optional, default "info". It is meant to be one
 *    of the log levels specified in the top of file comment. For backward
 *    compatibility it falls back to "trace".
 * @param {Object} customLogger - Optional. A custom logger object to which
 *    log messages will be passed. It must provide
 *    trace/debug/info/warn/error/fatal methods that take a string argument.
 *
 *
 * @param {string} [levelName=info] log level we want for the created logger
 * @param {Logger} [customLogger] custom logger object provided by the user
 * @returns {Logger}
 */
function createLogger(levelName, customLogger) {
  let dest;
  const serializers = {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  };

  if (!levelName) {
    levelName = DEFAULT_LOG_LEVEL;
  }
  let pinoLevel = PINO_LEVEL_FROM_LEVEL_NAME[levelName];
  if (!pinoLevel) {
    // For backwards compat, support an earlier bug where an unknown log level
    // was accepted.
    // TODO: Consider being more strict on this for v4.0.0.
    pinoLevel = 'trace';
  }

  if (customLogger) {
    // Is this a pino logger? If so, it supports the API the agent requires and
    // can be used directly. We must add our custom serializers.
    if (Symbol.for('pino.serializers') in customLogger) {
      // Pino added `options` second arg to `logger.child` in 6.12.0.
      if (semver.gte(customLogger.version, '6.12.0')) {
        // return customLogger.child({}, { serializers });
         return customLogger.child({ ...AGENT_METADATA }, { serializers });
      }

      return customLogger.child({
        ...AGENT_METADATA,
        serializers,
      });
    }

    dest = new SafePinoDestWrapper(customLogger);
    // Our wrapping logger level should be 'trace', to pass through all
    // messages to the wrapped logger.
    pinoLevel = 'trace';
  } else {
    // Log to stdout, the same default as pino itself.
    dest = pino.destination(1);
  }

  const logger = pino(
    {
      name: 'mtn-apm-agent',
      // base: {}, 
        // include agent metadata on every log line without pid/hostname noise.
      base: { ...AGENT_METADATA },
      level: pinoLevel,
      serializers,
      ...ecsFormat({ apmIntegration: false }),
    },
    dest,
  );

  if (!customLogger) {
    logger[LOGGER_IS_OURS_SYM] = true; // used for isLoggerCustom()
  }
  return logger;
}

/**
 * Returns true if the logger is not ours
 *
 * @param {Logger} logger
 * @returns {boolean}
 */
function isLoggerCustom(logger) {
  return !logger[LOGGER_IS_OURS_SYM];
}

/**
 * Adjust the level on the given logger.
 *
 * @param {Logger} logger
 * @param {string} levelName
 */
function setLogLevel(logger, levelName) {
  const pinoLevel = PINO_LEVEL_FROM_LEVEL_NAME[levelName];
  if (!pinoLevel) {
    logger.warn('unknown log levelName "%s": cannot setLogLevel', levelName);
  } else {
    logger.level = pinoLevel;
  }
}

module.exports = {
  DEFAULT_LOG_LEVEL,
  createLogger,
  isLoggerCustom,
  setLogLevel,
};
