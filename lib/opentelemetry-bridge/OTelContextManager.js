'use strict';

const EventEmitter = require('events');
const oblog = require('./oblog');
const { OTelBridgeRunContext } = require('./OTelBridgeRunContext');

class OTelContextManager {
  constructor(agent) {
    this._agent = agent;
    this._ins = agent._instrumentation;
  }

  active() {
    oblog.apicall('OTelContextManager.active()');
    return this._ins.currRunContext();
  }

  _runContextFromOTelContext(otelContext) {
    let runContext;
    if (otelContext instanceof OTelBridgeRunContext) {
      runContext = otelContext;
    } else {
  
      runContext = this._ins._runCtxMgr.root().setOTelContext(otelContext);
    }
    return runContext;
  }

  with(otelContext, fn, thisArg, ...args) {
    oblog.apicall(
      'OTelContextManager.with(%s<...>, function %s, ...)',
      otelContext.constructor.name,
      fn.name || '<anonymous>',
    );
    const runContext = this._runContextFromOTelContext(otelContext);
    return this._ins._runCtxMgr.with(runContext, fn, thisArg, ...args);
  }

  bind(otelContext, target) {
    oblog.apicall(
      'OTelContextManager.bind(%s, %s type)',
      otelContext,
      typeof target,
    );
    if (target instanceof EventEmitter) {
      const runContext = this._runContextFromOTelContext(otelContext);
      return this._ins._runCtxMgr.bindEE(runContext, target);
    }
    if (typeof target === 'function') {
      const runContext = this._runContextFromOTelContext(otelContext);
      return this._ins._runCtxMgr.bindFn(runContext, target);
    }
    return target;
  }

  enable() {
    oblog.apicall('OTelContextManager.enable()');
    this._ins._runCtxMgr.enable();
    return this;
  }

  disable() {
    oblog.apicall('OTelContextManager.disable()');
    this._ins._runCtxMgr.disable();
    return this;
  }
}

module.exports = {
  OTelContextManager,
};
