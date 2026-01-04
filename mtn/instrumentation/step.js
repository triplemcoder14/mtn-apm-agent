'use strict';

class Step {
  constructor(name, options, operation) {
    this.name = name;
    this.operation = operation;
    this.startTime = options.startTime || Date.now();
  }

  setLabel(key, value) {
    this[key] = value;
  }

  end() {
    this.duration = Date.now() - this.startTime;
  }
}

module.exports = Step;