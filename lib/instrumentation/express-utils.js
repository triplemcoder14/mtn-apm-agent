'use strict';

const url = require('url');

var symbols = require('../symbols');

function normalizeSlash(value) {
  return value[0] === '/' ? value : '/' + value;
}

function excludeRoot(value) {
  return value !== '/';
}

function join(parts) {
  if (!parts) return;
  return parts.filter(excludeRoot).map(normalizeSlash).join('') || '/';
}

// This works for both express AND restify
function routePath(route) {
  if (!route) return;
  return route.path || (route.regexp && route.regexp.source);
}

function getStackPath(req) {
  var stack = req[symbols.expressMountStack];
  return join(stack);
}

// This function is also able to extract the path from a Restify request as
// it's storing the route name on req.route.path as well
function getPathFromRequest(req, useBase, usePathAsTransactionName) {
  if (req[symbols.staticFile]) {
    return 'static file';
  }

  var path = getStackPath(req);
  var route = routePath(req.route);

  if (route) {
    return path ? join([path, route]) : route;
  } else if (path && (path !== '/' || useBase)) {
    return path;
  }

  if (usePathAsTransactionName) {
    let base;
    try {
     
      const url = new url.URL('http://' + (req.headers && req.headers.host));
      base = 'http://' + url.hostname;
    } catch (err) {
      base = 'http://undefined';
    }

    // We may receive invalid chars in the path also but the URL
    // constructor escapes them without throwing.
    const parsed = req.url.startsWith('/')
      ? new url.URL(base + req.url)
      : new url.URL(req.url, base);

    return parsed && parsed.pathname;
  }
}

module.exports = {
  getPathFromRequest,
  getStackPath,
  routePath,
};
