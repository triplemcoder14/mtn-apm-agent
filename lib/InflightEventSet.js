'use strict';

class InflightEventSet extends Set {
  setDrainHandler(fn, timeoutMs) {
    this._drainHandler = fn;
    if (timeoutMs) {
      this._drainTimeout = setTimeout(() => {
        this._drain(new Error('inflight event set drain timeout'));
      }, timeoutMs).unref();
    }
  }

  // Call the drain handler, if there is one.
  _drain(err) {
    if (this._drainHandler) {
      if (this._drainTimeout) {
        clearTimeout(this._drainTimeout);
        this._drainTimeout = null;
      }
      this._drainHandler(err);
      // Remove the handler so it is only called once.
      this._drainHandler = null;
    }
  }

  delete(key) {
    super.delete(key);
    if (this.size === 0) {
      this._drain();
    }
  }
}

module.exports = {
  InflightEventSet,
};
