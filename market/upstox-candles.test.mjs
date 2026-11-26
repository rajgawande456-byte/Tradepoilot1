import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstoxCandles } from './upstox-candles.mjs';

const nowMs = Date.parse('2026-11-27T10:00:00+05:30');
const t915 = Date.parse('2026-11-27T09:15:00+05:30');
const t920 = Date.parse('2026-11-27T09:20:00+05:30');
const t925 = Date.parse('2026-11-27T09:25:00+05:30');

test('normalizes provider ISO, epoch-second and epoch-millisecond timestamps', () => {
  const candles = normalizeUpstoxCandles([
    ['2026-11-27T09:15:00+05:30', 100, 105, 99, 104, 1200, 0],
    [t920 / 1000, 104, 107, 103, 106, 1500, 10],
    [t925, 106, 108, 105, 107, 1800]
  ], { nowMs });

  assert.deepEqual(candles.map(candle => candle.time), [
    Math.floor(t915 / 1000),
    Math.floor(t920 / 1000),
    Math.floor(t925 / 1000)
  ]);
  assert.equal(candles[0].oi, 0);
  assert.equal(candles[2].oi, null);
});

test('rejects missing, zero or negative OHLC and invalid volume or open interest', () => {
  const candles = normalizeUpstoxCandles([
    ['2026-11-27T09:15:00+05:30', 0, 105, 99, 104, 1200, 0],
    ['2026-11-27T09:20:00+05:30', -1, 105, 99, 104, 1200, 0],
    ['2026-11-27T09:25:00+05:30', 100, 105, 99, 104, -1, 0],
    ['2026-11-27T09:30:00+05:30', 100, 105, 99, 104, 1200, -1],
    ['2026-11-27T09:35:00+05:30', 100, 105, 99, 104, null, 0],
    ['2026-11-27T09:40:00+05:30', 100, 105, 99, 104]
  ], { nowMs });

  assert.equal(candles.length, 0);
});

test('rejects impossible OHLC relationships and timestamps outside the accepted range', () => {
  const candles = normalizeUpstoxCandles([
    ['2026-11-27T09:15:00+05:30', 100, 99, 98, 104, 1200, 0],
    ['2026-11-27T09:20:00+05:30', 100, 105, 101, 104, 1200, 0],
    ['1999-12-31T23:59:00Z', 100, 105, 99, 104, 1200, 0],
    ['2026-11-27T10:06:00+05:30', 100, 105, 99, 104, 1200, 0],
    ['not-a-timestamp', 100, 105, 99, 104, 1200, 0]
  ], { nowMs });

  assert.equal(candles.length, 0);
});

test('sorts candles and de-duplicates timestamps using the last valid provider row', () => {
  const candles = normalizeUpstoxCandles([
    ['2026-11-27T09:20:00+05:30', 104, 107, 103, 106, 1500, 0],
    ['2026-11-27T09:15:00+05:30', 100, 105, 99, 104, 1200, 0],
    ['2026-11-27T09:20:00+05:30', 104, 108, 103, 107, 1700, 0]
  ], { nowMs });

  assert.equal(candles.length, 2);
  assert.deepEqual(candles.map(candle => candle.time), [
    Math.floor(t915 / 1000),
    Math.floor(t920 / 1000)
  ]);
  assert.equal(candles[1].high, 108);
  assert.equal(candles[1].close, 107);
  assert.equal(candles[1].volume, 1700);
});

test('returns an empty list for a non-array provider payload', () => {
  assert.deepEqual(normalizeUpstoxCandles(null, { nowMs }), []);
});
