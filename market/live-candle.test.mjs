import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLiveTick } from './live-candle.mjs';

const nowMs = Date.parse('2026-11-28T03:00:30+05:30');
const tick = (overrides = {}) => ({
  symbol: 'NIFTY 50', sequence: 10, price: 25001.5,
  asOf: '2026-11-28T03:00:20+05:30', provider: 'UPSTOX V3 WS', ...overrides
});
const options = { symbol: 'NIFTY 50', intervalSeconds: 60, nowMs };

test('creates a live OHLC candle without inventing volume', () => {
  const result = applyLiveTick({ ...options, tick: tick() });
  assert.equal(result.accepted, true);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(
    [result.liveCandle.open, result.liveCandle.high, result.liveCandle.low, result.liveCandle.close],
    [25001.5, 25001.5, 25001.5, 25001.5]
  );
  assert.equal(result.liveCandle.volume, null);
});

test('updates the current candle OHLC and preserves historical volume', () => {
  const historical = [{
    time: Math.floor(Date.parse('2026-11-28T03:00:00+05:30') / 1000),
    open: 24990, high: 25000, low: 24980, close: 24995, volume: 1234
  }];
  const result = applyLiveTick({
    ...options, candles: historical,
    tick: tick({ price: 25002, sequence: 11, asOf: '2026-11-28T03:00:25+05:30' })
  });
  assert.equal(result.accepted, true);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(
    [result.liveCandle.open, result.liveCandle.high, result.liveCandle.low, result.liveCandle.close, result.liveCandle.volume],
    [24990, 25002, 24980, 25002, 1234]
  );
});

test('starts a new interval candle when the timestamp enters the next bucket', () => {
  const first = applyLiveTick({ ...options, tick: tick() });
  const second = applyLiveTick({
    ...options, nowMs: Date.parse('2026-11-28T03:01:05+05:30'),
    candles: first.candles, lastSequence: first.lastSequence, lastTickAtMs: first.lastTickAtMs,
    tick: tick({ sequence: 11, price: 25005, asOf: '2026-11-28T03:01:02+05:30' })
  });
  assert.equal(second.accepted, true);
  assert.equal(second.candles.length, 2);
  assert.equal(second.liveCandle.open, 25005);
  assert.equal(second.liveCandle.volume, null);
});

test('rejects missing timestamps instead of substituting local receipt time', () => {
  const result = applyLiveTick({ ...options, tick: tick({ asOf: undefined }) });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing_timestamp');
});

test('rejects stale, future, wrong-symbol and provider-less ticks', () => {
  for (const candidate of [
    tick({ asOf: '2026-11-28T02:59:00+05:30' }),
    tick({ asOf: '2026-11-28T03:01:00+05:30' }),
    tick({ symbol: 'BANKNIFTY' }),
    tick({ provider: '' })
  ]) assert.equal(applyLiveTick({ ...options, tick: candidate }).accepted, false);
});

test('rejects duplicate sequence and backward exchange timestamps', () => {
  assert.equal(
    applyLiveTick({ ...options, lastSequence: 10, tick: tick({ sequence: 10 }) }).reason,
    'out_of_order_sequence'
  );
  assert.equal(
    applyLiveTick({
      ...options, lastTickAtMs: Date.parse('2026-11-28T03:00:25+05:30'),
      tick: tick({ asOf: '2026-11-28T03:00:20+05:30' })
    }).reason,
    'out_of_order_timestamp'
  );
});

test('accepts a restarted backend sequence only when exchange time advances', () => {
  const result = applyLiveTick({
    ...options,
    lastSequence: 500,
    lastTickAtMs: Date.parse('2026-11-28T03:00:15+05:30'),
    tick: tick({ sequence: 1, asOf: '2026-11-28T03:00:25+05:30' })
  });
  assert.equal(result.accepted, true);
  assert.equal(result.lastSequence, 1);
});

test('rejects a tick whose candle bucket predates the chart', () => {
  const later = [{
    time: Math.floor(Date.parse('2026-11-28T03:01:00+05:30') / 1000),
    open: 25000, high: 25010, low: 24990, close: 25005, volume: 500
  }];
  const result = applyLiveTick({
    ...options, candles: later,
    tick: tick({ asOf: '2026-11-28T03:00:20+05:30' })
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'older_than_chart');
});
