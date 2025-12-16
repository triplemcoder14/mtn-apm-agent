'use strict';

const async_hooks = require('async_hooks');
const semver = require('semver');

let AsyncResource;
if (semver.satisfies(process.versions.node, '>=17.8.0')) {
  AsyncResource = async_hooks.AsyncResource;
} else {
  AsyncResource = class extends async_hooks.AsyncResource {
    static bind(fn, type, thisArg) {
      type = type || fn.name;
      return new AsyncResource(type || 'bound-anonymous-fn').bind(fn, thisArg);
    }

    bind(fn, thisArg) {
      let bound;
      if (thisArg === undefined) {
        const resource = this;
        bound = function (...args) {
          args.unshift(fn, this);
          return Reflect.apply(resource.runInAsyncScope, resource, args);
        };
      } else {
        bound = this.runInAsyncScope.bind(this, fn, thisArg);
      }
      Object.defineProperties(bound, {
        length: {
          configurable: true,
          enumerable: false,
          value: fn.length,
          writable: false,
        },
        asyncResource: {
          configurable: true,
          enumerable: true,
          value: this,
          writable: true,
        },
      });
      return bound;
    }
  };
}

module.exports = {
  AsyncResource,
};
