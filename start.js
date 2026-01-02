
'use strict';

const apm = require('./');

var isMainThread;
try {
  var workerThreads = require('worker_threads');
  isMainThread = workerThreads.isMainThread;
} catch (_importErr) {
  isMainThread = true;
}
if (isMainThread) {
  apm.start();
}

module.exports = apm;
