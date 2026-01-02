'use strict';

const apm = require('../index');

class MtnAgent {
  start(options) {
    apm.start(options);
    return this;
  }

  isStarted() {
    return apm.isStarted();
  }


  startOperation(name, options) {
    return apm.startTransaction(name, options);
  }

  get currentOperation() {
    return apm.currentTransaction;
  }

  endOperation(result) {
    apm.endTransaction(result);
  }


  startStep(name, options) {
    return apm.startSpan(name, options);
  }

  get currentStep() {
    return apm.currentSpan;
  }


  reportError(error, options) {
    apm.captureError(error, options);
  }

  setAttributes(attributes) {
    if (attributes && typeof attributes === 'object') {
      apm.addLabels(attributes);
    }
  }

  setUser(user) {
    if (user && typeof user === 'object') {
      apm.setUserContext(user);
    }
  }


  flush() {
    return apm.flush();
  }

  shutdown() {
    return apm.destroy();
  }
}

module.exports = new MtnAgent();
