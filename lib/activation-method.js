'use strict';

const path = require('path');

const errorStackParser = require('error-stack-parser');
const semver = require('semver');

var { isLambdaExecutionEnvironment } = require('./lambda');

const CONTAINS_R_ELASTIC_APM_NODE_START =
  /(-r\s+|--require\s*=?\s*).*elastic-apm-node\/start/;

/**
 * Determine the 'service.agent.activation_method' metadata value from an Error
 * stack collected at `Agent.start()` time. Spec:
 *
 * @param {Error} startStack - An Error object with a captured stack trace.
 *    The `stackTraceLimit` for the stack should be at least 15 -- higher
 *    that the default of 10.
 * @returns {string} one of the following values:
 *    - "unknown"
 *    - "require":
 *         require('elastic-apm-node').start(...)
 *         require('elastic-apm-node/start')
 *    - "import":
 *         import 'elastic-apm-node/start.js'
 *    - "env-attach": Fallback for any other usage of NODE_OPTIONS='-r elastic-apm-node/start'
 *    - "preload": For usage of `node -r elastic-apm-node/start` without `NODE_OPTIONS`.
 */
function agentActivationMethodFromStartStack(startStack, log) {
  /* @param {require('stackframe').StackFrame[]} frames */
  let frames;
  try {
    frames = errorStackParser.parse(startStack);
  } catch (parseErr) {
    log.trace(
      parseErr,
      'could not determine metadata.service.agent.activation_method',
    );
    return 'unknown';
  }
  if (frames.length < 2) {
    return 'unknown';
  }

  const topDir = path.dirname(path.dirname(frames[0].fileName));

  // If this was a preload (i.e. using `-r elastic-apm-node/start`), then
  // there will be a frame with `functionName` equal to:
  // - node >=12: 'loadPreloadModules'
  // - node <12: 'preloadModules'
  const functionName = semver.gte(process.version, '12.0.0', {
    includePrerelease: true,
  })
    ? 'loadPreloadModules'
    : 'preloadModules';
  let isPreload = false;
  for (let i = frames.length - 1; i >= 2; i--) {
    if (frames[i].functionName === functionName) {
      isPreload = true;
      break;
    }
  }
  if (isPreload) {
    if (
      isLambdaExecutionEnvironment &&
      topDir === '/opt/nodejs/node_modules/elastic-apm-node'
    ) {
      // and created by "dev-utils/make-distribution.sh".
      return 'aws-lambda-layer';
    } else if (
      process.env.ELASTIC_APM_ACTIVATION_METHOD === 'K8S_ATTACH' ||
      process.env.ELASTIC_APM_ACTIVATION_METHOD === 'K8S'
    ) {
      // apm-k8s-attacher v0.1.0 started setting value to K8S.
      // v0.4.0 will start using 'K8S_ATTACH'.
      return 'k8s-attach';
    } else if (
      process.env.NODE_OPTIONS &&
      CONTAINS_R_ELASTIC_APM_NODE_START.test(process.env.NODE_OPTIONS)
    ) {
      return 'env-attach';
    } else {
      return 'preload';
    }
  }

  // been the name of this method back to at least Node v8.
  const esmImportFunctionName = 'ModuleJob.run';
  if (esmImportFunctionName) {
    for (let i = frames.length - 1; i >= 2; i--) {
      if (frames[i].functionName === esmImportFunctionName) {
        return 'import';
      }
    }
  }

  // Otherwise this was a manual `require(...)` of the agent in user code.
  return 'require';
}

module.exports = {
  agentActivationMethodFromStartStack,
};
