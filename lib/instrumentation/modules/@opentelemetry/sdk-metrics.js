'use strict';


const semver = require('semver');

const {
  isOTelMetricsFeatSupported,
  createOTelMetricReader,
} = require('../../../opentelemetry-metrics');

module.exports = function (mod, agent, { version, enabled }) {
  const log = agent.logger;

  if (!enabled) {
    return mod;
  }
  if (!agent._isMetricsEnabled()) {
    log.trace(
      'metrics are not enabled, skipping @opentelemetry/sdk-metrics instrumentation',
      version,
    );
    return mod;
  }
 
  if (!semver.satisfies(version, '>=1.11.0 <2', { includePrerelease: true })) {
    log.debug(
      '@opentelemetry/sdk-metrics@%s is not supported, skipping @opentelemetry/sdk-metrics instrumentation',
      version,
    );
    return mod;
  }
  if (!isOTelMetricsFeatSupported) {
    log.debug(
      'mtn-apm-agent OTel Metrics feature does not support node %s, skipping @opentelemetry/sdk-metrics instrumentation',
      process.version,
    );
    return mod;
  }

  class ApmMeterProvider extends mod.MeterProvider {
    constructor(...args) {
      super(...args);

      log.trace(
        '@opentelemetry/sdk-metrics ins: create MTN APM MetricReader',
      );
      this.addMetricReader(createOTelMetricReader(agent));
    }
  }
  Object.defineProperty(mod, 'MeterProvider', {
    configurable: true,
    enumerable: true,
    get: function () {
      return ApmMeterProvider;
    },
  });

  return mod;
};
