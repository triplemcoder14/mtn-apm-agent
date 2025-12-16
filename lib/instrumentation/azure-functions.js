
'use strict';

const fs = require('fs');
const path = require('path');

const constants = require('../constants');

let isInstrumented = false;
let hookDisposables = []; 

let isFirstRun = true;

// The trigger types for which we support special handling.
const TRIGGER_OTHER = 1; //
const TRIGGER_HTTP = 2; 
const TRIGGER_TIMER = 3; 
const TRANS_TYPE_FROM_TRIGGER_TYPE = {
  [TRIGGER_OTHER]: 'request',
  [TRIGGER_HTTP]: 'request',
  // Note: `transaction.type = "scheduled"` is not in the shared APM agent spec,
  // but the Java agent used the same value for some instrumentations.
  [TRIGGER_TIMER]: 'scheduled',
};

const FAAS_TRIGGER_TYPE_FROM_TRIGGER_TYPE = {
  [TRIGGER_OTHER]: 'other',
  [TRIGGER_HTTP]: 'http',
  // Note: `faas.trigger = "timer"` is not in the shared APM agent spec yet.
  [TRIGGER_TIMER]: 'timer',
};

const gHttpRouteFromFuncDir = new Map();
const DEFAULT_ROUTE_PREFIX = 'api';
let gRoutePrefix = null;


// to help with handling.
// ...plus some additional functionality for `httpRoute` and `routePrefix`.
class FunctionInfo {
  constructor(bindingDefinitions, executionContext, log) {
    // Example `bindingDefinitions`:
    //    [{"name":"req","type":"httpTrigger","direction":"in"},
    //    {"name":"res","type":"http","direction":"out"}]
    this.triggerType = TRIGGER_OTHER;
    this.httpOutputName = '';
    this.hasHttpTrigger = false;
    this.hasReturnBinding = false;
    this.outputBindingNames = [];
    for (const bd of bindingDefinitions) {
      if (bd.direction !== 'in') {
        if (bd.type && bd.type.toLowerCase() === 'http') {
          this.httpOutputName = bd.name;
        }
        this.outputBindingNames.push(bd.name);
        if (bd.name === '$return') {
          this.hasReturnBinding = true;
        }
      }
      if (bd.type) {
        const typeLc = bd.type.toLowerCase();
        switch (typeLc) {
          case 'httptrigger': // "type": "httpTrigger"
            this.triggerType = TRIGGER_HTTP;
            break;
          case 'timertrigger':
            this.triggerType = TRIGGER_TIMER;
            break;
        }
      }
    }

    // If this is an HTTP triggered-function, then get its route template and
    // is in "host.json".
    this.httpRoute = null;
    this.routePrefix = null;
    if (this.triggerType === TRIGGER_HTTP) {
      const funcDir = executionContext.functionDirectory;
      if (!funcDir) {
        this.httpRoute = executionContext.functionName;
      } else if (gHttpRouteFromFuncDir.has(funcDir)) {
        this.httpRoute = gHttpRouteFromFuncDir.get(funcDir);
      } else {
        try {
          const fj = JSON.parse(
            fs.readFileSync(path.join(funcDir, 'function.json')),
          );
          for (let i = 0; i < fj.bindings.length; i++) {
            const binding = fj.bindings[i];
            if (
              binding.direction === 'in' &&
              binding.type &&
              binding.type.toLowerCase() === 'httptrigger'
            ) {
              if (binding.route !== undefined) {
                this.httpRoute = binding.route;
              } else {
                this.httpRoute = executionContext.functionName;
              }
              gHttpRouteFromFuncDir.set(funcDir, this.httpRoute);
            }
          }
          log.trace(
            { funcDir, httpRoute: this.httpRoute },
            'azure-functions: loaded route',
          );
        } catch (httpRouteErr) {
          log.debug(
            'azure-functions: could not determine httpRoute for function %s: %s',
            executionContext.functionName,
            httpRouteErr.message,
          );
          this.httpRoute = executionContext.functionName;
        }
      }

      if (gRoutePrefix) {
        this.routePrefix = gRoutePrefix;
      } else if (!funcDir) {
        this.routePrefix = gRoutePrefix = DEFAULT_ROUTE_PREFIX;
      } else {
        try {
          const hj = JSON.parse(
            fs.readFileSync(path.join(path.dirname(funcDir), 'host.json')),
          );
          if (
            hj &&
            hj.extensions &&
            hj.extensions.http &&
            hj.extensions.http.routePrefix !== undefined
          ) {
            const rawRoutePrefix = hj.extensions.http.routePrefix;
            this.routePrefix = gRoutePrefix = normRoutePrefix(rawRoutePrefix);
            log.trace(
              { hj, routePrefix: this.routePrefix, rawRoutePrefix },
              'azure-functions: loaded route prefix',
            );
          } else {
            this.routePrefix = gRoutePrefix = DEFAULT_ROUTE_PREFIX;
          }
        } catch (routePrefixErr) {
          log.debug(
            'azure-functions: could not determine routePrefix: %s',
            routePrefixErr.message,
          );
          this.routePrefix = gRoutePrefix = DEFAULT_ROUTE_PREFIX;
        }
      }
    }
  }
}

function normRoutePrefix(routePrefix) {
  return routePrefix.startsWith('/') ? routePrefix.slice(1) : routePrefix;
}

/**
 * Set transaction data for HTTP triggers from the Lambda function result.
 */
function setTransDataFromHttpTriggerResult(trans, hookCtx) {
  if (hookCtx.error) {
    trans.setOutcome(constants.OUTCOME_FAILURE);
    trans.result = 'HTTP 5xx';
    trans.res = {
      statusCode: 500,
    };
    return;
  }

  const funcInfo = hookCtx.hookData.funcInfo;
  const result = hookCtx.result;
  const context = hookCtx.invocationContext;
  let httpRes;
  if (funcInfo.hasReturnBinding) {
    httpRes = hookCtx.result;
  } else {
    if (
      result &&
      typeof result === 'object' &&
      result[funcInfo.httpOutputName] !== undefined
    ) {
      httpRes = result[funcInfo.httpOutputName];
    } else if (
      context.bindings &&
      context.bindings[funcInfo.httpOutputName] !== undefined
    ) {
      httpRes = context.bindings[funcInfo.httpOutputName];
    } else if (context.res !== undefined) {
      httpRes = context.res;
    }
  }
  if (typeof httpRes !== 'object') {
    trans.setOutcome(constants.OUTCOME_FAILURE);
    trans.result = 'HTTP 5xx';
    trans.res = {
      statusCode: 500,
    };
    return;
  }

  let statusCode = Number(httpRes.status);
  if (!Number.isInteger(statusCode)) {
    // suggests the default may be "HTTP 204 No Content", my observation is that
    // 200 is the actual default.
    statusCode = 200;
  }

  if (statusCode < 500) {
    trans.setOutcome(constants.OUTCOME_SUCCESS);
  } else {
    trans.setOutcome(constants.OUTCOME_FAILURE);
  }
  trans.result = 'HTTP ' + statusCode.toString()[0] + 'xx';
  trans.res = {
    statusCode,
    body: httpRes.body,
  };
  if (httpRes.headers && typeof httpRes.headers === 'object') {
    trans.res.headers = httpRes.headers;
  }
}

function getAzureAccountId() {
  return (
    process.env.WEBSITE_OWNER_NAME &&
    process.env.WEBSITE_OWNER_NAME.split('+', 1)[0]
  );
}

// ---- exports

const isAzureFunctionsEnvironment = !!process.env.FUNCTIONS_WORKER_RUNTIME;

function getAzureFunctionsExtraMetadata() {
  const metadata = {
    service: {
      framework: {
        // Passing this service.framework.name to Client#setExtraMetadata()
        // ensures that it "wins" over a framework name from
        // `agent.setFramework()`, because in the client `_extraMetadata`
        // wins over `_conf.frameworkName`.
        name: 'Azure Functions',
        version: process.env.FUNCTIONS_EXTENSION_VERSION,
      },
      runtime: {
        name: process.env.FUNCTIONS_WORKER_RUNTIME,
      },
      node: {
        configured_name: process.env.WEBSITE_INSTANCE_ID,
      },
    },
    cloud: {
      provider: 'azure',
      region: process.env.REGION_NAME,
      service: {
        name: 'functions',
      },
    },
  };
  const accountId = getAzureAccountId();
  if (accountId) {
    metadata.cloud.account = { id: accountId };
  }
  if (process.env.WEBSITE_SITE_NAME) {
    metadata.cloud.instance = { name: process.env.WEBSITE_SITE_NAME };
  }
  if (process.env.WEBSITE_RESOURCE_GROUP) {
    metadata.cloud.project = { name: process.env.WEBSITE_RESOURCE_GROUP };
  }
  return metadata;
}

function instrument(agent) {
  if (isInstrumented) {
    return;
  }
  isInstrumented = true;

  const ins = agent._instrumentation;
  const log = agent.logger;
  let d;

  let core;
  try {
    core = require('@azure/functions-core');
  } catch (err) {
    log.warn(
      { err },
      'could not import "@azure/functions-core": skipping Azure Functions instrumentation',
    );
    return;
  }


  d = core.registerHook('preInvocation', (hookCtx) => {
    if (!hookCtx.invocationContext) {
      return;
    }

    const context = hookCtx.invocationContext;
    const invocationId = context.invocationId;
    log.trace({ invocationId }, 'azure-functions: preInvocation');

    const isColdStart = isFirstRun;
    if (isFirstRun) {
      isFirstRun = false;
    }

    let bindingDefinitions = context.bindingDefinitions;
    if (!bindingDefinitions) {
      bindingDefinitions = [];
      // Input bindings
      bindingDefinitions.push({
        name: context?.options?.trigger?.name,
        type: context?.options?.trigger?.type,
        direction: context?.options?.trigger?.direction,
      });
      // Output bindings
      if (context?.options?.return) {
        bindingDefinitions.push(context?.options?.return);
      }
    }
    let executionContext = context.executionContext;
    if (!executionContext) {
      executionContext = {
        functionDirectory: '',
        functionName: context.functionName,
      };
    }

    const funcInfo = (hookCtx.hookData.funcInfo = new FunctionInfo(
      bindingDefinitions,
      executionContext,
      log,
    ));
    const triggerType = funcInfo.triggerType;

  
    let traceparent;
    let tracestate;
    if (triggerType === TRIGGER_HTTP && context?.req?.headers?.traceparent) {
      traceparent = context.req.headers.traceparent;
      tracestate = context.req.headers.tracestate;
      log.trace(
        { traceparent, tracestate },
        'azure-functions: get trace-context from HTTP trigger request headers',
      );
    }

    const trans = (hookCtx.hookData.trans = ins.startTransaction(
      // This is the default name. Trigger-specific values are added below.
      executionContext.functionName,
      TRANS_TYPE_FROM_TRIGGER_TYPE[triggerType],
      {
        childOf: traceparent,
        tracestate,
      },
    ));

    const accountId = getAzureAccountId();
    const resourceGroup = process.env.WEBSITE_RESOURCE_GROUP;
    const fnAppName = process.env.WEBSITE_SITE_NAME;
    const fnName = executionContext.functionName;
    const faasData = {
      trigger: {
        type: FAAS_TRIGGER_TYPE_FROM_TRIGGER_TYPE[triggerType],
      },
      execution: invocationId,
      coldstart: isColdStart,
    };
    if (accountId && resourceGroup && fnAppName) {
      faasData.id = `/subscriptions/${accountId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${fnAppName}/functions/${fnName}`;
    }
    if (fnAppName && fnName) {
      faasData.name = `${fnAppName}/${fnName}`;
    }
    trans.setFaas(faasData);

    if (triggerType === TRIGGER_HTTP) {
  
      const req = hookCtx.inputs[0];
      if (req) {
        trans.req = req; // Used for setting `trans.context.request` by `getContextFromRequest()`.
        if (agent._conf.usePathAsTransactionName && req.url) {
          trans.setDefaultName(`${req.method} ${new URL(req.url).pathname}`);
        } else {
          const route = funcInfo.routePrefix
            ? `/${funcInfo.routePrefix}/${funcInfo.httpRoute}`
            : `/${funcInfo.httpRoute}`;
          trans.setDefaultName(`${req.method} ${route}`);
        }
      }
    }
  });
  hookDisposables.push(d);

  d = core.registerHook('postInvocation', (hookCtx) => {
    if (!hookCtx.invocationContext) {
      // Doesn't look like `require('@azure/functions-core').PreInvocationContext`. Abort.
      return;
    }
    const invocationId = hookCtx.invocationContext.invocationId;
    log.trace({ invocationId }, 'azure-functions: postInvocation');

    const trans = hookCtx.hookData.trans;
    if (!trans) {
      return;
    }

    const funcInfo = hookCtx.hookData.funcInfo;
    if (funcInfo.triggerType === TRIGGER_HTTP) {
      setTransDataFromHttpTriggerResult(trans, hookCtx);
    } else if (hookCtx.error) {
      trans.result = constants.RESULT_FAILURE;
      trans.setOutcome(constants.OUTCOME_FAILURE);
    } else {
      trans.result = constants.RESULT_SUCCESS;
      trans.setOutcome(constants.OUTCOME_SUCCESS);
    }

    if (hookCtx.error) {
      agent.captureError(hookCtx.error, { skipOutcome: true });
    }

    trans.end();
  });
  hookDisposables.push(d);
}

function uninstrument() {
  if (!isInstrumented) {
    return;
  }
  isInstrumented = false;

  // Unregister `core.registerHook()` calls from above.
  hookDisposables.forEach((d) => {
    d.dispose();
  });
  hookDisposables = [];
}

module.exports = {
  isAzureFunctionsEnvironment,
  getAzureFunctionsExtraMetadata,
  instrument,
  uninstrument,
};
