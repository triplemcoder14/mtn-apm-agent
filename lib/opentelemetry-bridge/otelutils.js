'use strict';

const otel = require('@opentelemetry/api');
const semver = require('semver');
const timeOrigin = require('perf_hooks').performance.timeOrigin;

// Note: This is *OTel's* TraceState class, which differs from our TraceState
// class in "lib/tracecontext/...".
const { TraceState } = require('./opentelemetry-core-mini/trace/TraceState');

const haveUsablePerformanceNow = semver.satisfies(process.version, '>=8.12.0');

function isTimeInputHrTime(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

function epochMsFromOTelTimeInput(otelTimeInput) {
  if (isTimeInputHrTime(otelTimeInput)) {
    // OTel's HrTime is `[<seconds since unix epoch>, <nanoseconds>]`
    return otelTimeInput[0] * 1e3 + otelTimeInput[1] / 1e6;
  } else if (typeof otelTimeInput === 'number') {
    // Assume a performance.now() if it's smaller than process start time.
    if (haveUsablePerformanceNow && otelTimeInput < timeOrigin) {
      return timeOrigin + otelTimeInput;
    } else {
      return otelTimeInput;
    }
  } else if (otelTimeInput instanceof Date) {
    return otelTimeInput.getTime();
  } else {
    throw TypeError(`Invalid OTel TimeInput: ${otelTimeInput}`);
  }
}

// Convert an OTel SpanContext to a traceparent string.
function traceparentStrFromOTelSpanContext(spanContext) {
  return `00-${spanContext.traceId}-${spanContext.spanId}-0${Number(
    spanContext.traceFlags || otel.TraceFlags.NONE,
  ).toString(16)}`;
}

// Convert an Elastic TraceContext instance to an OTel SpanContext.
// These are the Elastic and OTel classes for storing W3C trace-context data.
function otelSpanContextFromTraceContext(traceContext) {
  const traceparent = traceContext.traceparent;
  const otelSpanContext = {
    traceId: traceparent.traceId,
    spanId: traceparent.id,
    // `traceparent.flags` is a two-char hex string. `traceFlags` is a number.
    // This conversion assumes `traceparent.flags` are valid.
    traceFlags: parseInt(traceparent.flags, 16),
  };
  const traceStateStr = traceContext.toTraceStateString();
  if (traceStateStr) {
    otelSpanContext.traceState = new TraceState(traceStateStr);
  }
  return otelSpanContext;
}

module.exports = {
  epochMsFromOTelTimeInput,
  otelSpanContextFromTraceContext,
  traceparentStrFromOTelSpanContext,
};
