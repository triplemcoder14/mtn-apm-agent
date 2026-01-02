'use strict';

const { AsyncResource } = require('../../../../../async-hooks-polyfill');

const semver = require('semver');

module.exports = (mod, agent, { version, enabled }) => {
  if (!enabled) return mod;
  if (!semver.satisfies(version, '>=3.3 <6.4.0')) {
    // - mongodb <3.3 is instrumented via mongodb-core
    // - mongodb >=6.4.0 now longer requires ConnectionPool#checkOut to be
    //   patched to fix async context tracking. See discussion at
    return mod;
  }
  agent.logger.debug('instrumenting mongodb ConnectionPool#checkOut');

  if (mod.ConnectionPool) {
    class ConnectionPoolTraced extends mod.ConnectionPool {
      checkOut(callback) {
        return super.checkOut(AsyncResource.bind(callback));
      }
    }

    Object.defineProperty(mod, 'ConnectionPool', {
      enumerable: true,
      get: function () {
        return ConnectionPoolTraced;
      },
    });

    return mod;
  }
};
