'use strict';

var semver = require('semver');

var shimmer = require('../../shimmer');

var onPreAuthSym = Symbol('ElasticAPMOnPreAuth');

function simpleDataFromEventData(agent, eventData) {
  try {
    let simpleRepr = simpleReprFromVal(eventData);
    if (simpleRepr !== undefined) {
      return simpleRepr;
    }

    let n = 0;
    const attrs = {};
    const keys = Object.keys(eventData);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      let val = eventData[key];
      simpleRepr = simpleReprFromVal(val);
      if (simpleRepr) {
        attrs[key] = simpleRepr;
        n++;
      }
    }
    return n ? attrs : undefined;
  } catch (err) {
    agent.logger.trace(
      'hapi: could not gather simple attrs from event data: ' + err.message,
    );
  }
}

function simpleReprFromVal(val) {
  switch (typeof val) {
    case 'boolean':
    case 'string':
    case 'number':
      break;
    case 'object':
      // Ignore all objects except Dates.
      if (
        val === null ||
        typeof val.toISOString !== 'function' ||
        typeof val.getTime !== 'function'
      ) {
        return;
      } else if (Number.isNaN(val.getTime())) {
        val = 'Invalid Date'; // calling toISOString() on invalid dates throws
      } else {
        val = val.toISOString();
      }
      break;
    default:
      return;
  }
  return val;
}

module.exports = function (hapi, agent, { version, enabled }) {
  if (!enabled) {
    return hapi;
  }
  if (!semver.satisfies(version, '>=17.9.0 <22.0.0')) {
    agent.logger.debug('@hapi/hapi@%s not supported, skipping', version);
    return hapi;
  }

  agent.setFramework({ name: 'hapi', version, overwrite: false });

  agent.logger.debug('shimming hapi.Server, hapi.server');
  shimmer.massWrap(hapi, ['Server', 'server'], function (orig) {
    return function (options) {
      var res = orig.apply(this, arguments);
      patchServer(res);
      return res;
    };
  });

  function patchServer(server) {
    // Hooks that are always allowed
    if (typeof server.on === 'function') {
      attachEvents(server);
    } else if (typeof server.events.on === 'function') {
      attachEvents(server.events);
    } else {
      agent.logger.debug('unable to enable hapi error tracking');
    }

    server.ext('onPreAuth', onPreAuth);
    server.ext('onPreResponse', onPreResponse);
    if (agent._conf.captureBody !== 'off') {
      server.ext('onPostAuth', onPostAuth);
    }
  }

  function attachEvents(emitter) {
    emitter.on('log', function (event, tags) {
      captureError('log', null, event, tags);
    });

    emitter.on('request', function (req, event, tags) {
      captureError('request', req, event, tags);
    });
  }

  function captureError(type, req, event, tags) {
    if (!event || !tags.error || event.channel === 'internal') {
      return;
    }

    const info = event.error || event.data;
    let errOrStr, data;
    if (info instanceof Error || typeof info === 'string') {
      errOrStr = info;
    } else if (info) {
      data = simpleDataFromEventData(agent, info);
    }
    if (!errOrStr) {
      errOrStr = 'hapi server emitted a "' + type + '" event tagged "error"';
    }

    agent.captureError(errOrStr, {
      custom: {
        tags: event.tags,
        data,
      },
      request: req && req.raw && req.raw.req,
    });
  }

  function onPreAuth(request, reply) {
    agent.logger.debug('received hapi onPreAuth event');

    request[onPreAuthSym] = true;

    if (request.route) {
      var fingerprint = request.route.fingerprint || request.route.path;

      if (fingerprint) {
        var name =
          (request.raw && request.raw.req && request.raw.req.method) ||
          (request.route.method && request.route.method.toUpperCase());

        if (typeof name === 'string') {
          name = name + ' ' + fingerprint;
        } else {
          name = fingerprint;
        }

        agent._instrumentation.setDefaultTransactionName(name);
      }
    }

    return reply.continue;
  }

  function onPostAuth(request, reply) {
    if (request.payload && request.raw && request.raw.req) {
      // Save the parsed req body to be picked up by getContextFromRequest().
      request.raw.req.payload = request.payload;
    }
    return reply.continue;
  }

  function onPreResponse(request, reply) {
    agent.logger.debug('received hapi onPreResponse event');

    if (
      !request[onPreAuthSym] &&
      request.route &&
      request.route.path === '/{p*}' &&
      request.raw &&
      request.raw.req &&
      request.raw.req.method === 'OPTIONS' &&
      request.raw.req.headers['access-control-request-method']
    ) {
      agent._instrumentation.setDefaultTransactionName('CORS preflight');
    }

    return reply.continue;
  }

  return hapi;
};
