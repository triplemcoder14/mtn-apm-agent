'use strict';

const Operation = require('./operation');
const Step = require('./step');

class Instrumentation {
  constructor(agent) {
    this.agent = agent;
    this._currentOperation = null;
    this._currentStep = null;
  }

  start() {}

  stop() {
    this._currentOperation = null;
    this._currentStep = null;
  }

  startOperation(name, options) {
    const op = new Operation(name, options, this.agent);
    this._currentOperation = op;
    return op;
  }

  endOperation(result) {
    if (this._currentOperation) {
      this._currentOperation.end(result);
      this._currentOperation = null;
    }
  }

  startStep(name, options) {
    if (!this._currentOperation) return null;
    const step = new Step(name, options, this._currentOperation);
    this._currentStep = step;
    return step;
  }

  get currentOperation() {
    return this._currentOperation;
  }

  get currentStep() {
    return this._currentStep;
  }
}

module.exports = Instrumentation;
