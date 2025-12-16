'use strict';

// Shared functionality between the instrumentations of:
// - elasticsearch - the legacy Elasticsearch JS client
// - @elastic/elasticsearch - the new Elasticsearch JS client

// Only capture the ES request body if the request path matches the
// `elasticsearchCaptureBodyUrls` config.
function shouldCaptureBody(path, elasticsearchCaptureBodyUrlsRegExp) {
  if (!path) {
    return false;
  }
  for (var i = 0; i < elasticsearchCaptureBodyUrlsRegExp.length; i++) {
    const re = elasticsearchCaptureBodyUrlsRegExp[i];
    if (re.test(path)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string | null} path
 * @param {string | null} body
 * @param {RegExp[]} elasticsearchCaptureBodyUrlsRegExp
 * @return {string | undefined}
 */
function getElasticsearchDbStatement(
  path,
  body,
  elasticsearchCaptureBodyUrlsRegExp,
) {
  if (body && shouldCaptureBody(path, elasticsearchCaptureBodyUrlsRegExp)) {
    if (typeof body === 'string') {
      return body;
    } else if (Buffer.isBuffer(body) || typeof body.pipe === 'function') {

    } else if (Array.isArray(body)) {
      try {
        return body.map(JSON.stringify).join('\n') + '\n'; // ndjson
      } catch (_ignoredErr) {}
    } else if (typeof body === 'object') {
      try {
        return JSON.stringify(body);
      } catch (_ignoredErr) {}
    }
  }
}

module.exports = {
  getElasticsearchDbStatement,
};
