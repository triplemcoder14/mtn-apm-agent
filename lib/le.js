'use strict';

const Instrumentation = require('../../instrumentation');
const Metrics = require('../../metrics');
const ApmClient = require('../../mtn-apm-client');

class Agent {
  constructor() {
    this._started = false;
    this._config = {};
    this._instrumentation = new Instrumentation(this);
    this._metrics = new Metrics(this);
    this._client = null;
  }

  start(options = {}) {
    if (this._started) {
      throw new Error('MTN APM agent already started');
    }

    this._config = options;
    this._started = true;

    if (options.active === false) {
      return this;
    }

    this._client = new ApmClient(options);
    this._instrumentation.start();
    this._metrics.start();

    return this;
  }


}
  isStarted() {
    return this._started;
  }

  shutdown() {
    this._metrics.stop();
    this._instrumentation.stop();
    this._client && this._client.shutdown();
    this._started = false;
    return Promise.resolve();
  }


  startOperation(name, options = {}) {
    return this._instrumentation.startOperation(name, options);
  }

  endOperation(result) {
    return this._instrumentation.endOperation(result);
  }

  get currentOperation() {
    return this._instrumentation.currentOperation;
  }

  startStep(name, options = {}) {
    return this._instrumentation.startStep(name, options);
  }

  get currentStep() {
    return this._instrumentation.currentStep;
  }

  setAttributes(attrs) {
    const op = this.currentOperation;
    if (op) op.setAttributes(attrs);
  }

  setUser(user) {
    const op = this.currentOperation;
    if (op) op.setUser(user);
  }

  reportError(error, options = {}) {
    if (!this._client) return;
    this._client.sendError(error, options, this.currentOperation);
  }

  flush() {
    return this._client ? this._client.flush() : Promise.resolve();
  }
}

module.exports = Agent;
