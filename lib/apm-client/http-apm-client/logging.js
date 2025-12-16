'use strict';

class NoopLogger {
  trace() {}
  debug() {}
  info() {}
  warn() {}
  error() {}
  fatal() {}
  child() {
    return this;
  }
  isLevelEnabled(_level) {
    return false;
  }
}

module.exports = {
  NoopLogger,
};
