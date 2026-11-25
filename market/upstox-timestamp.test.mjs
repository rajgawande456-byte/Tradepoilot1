import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUpstoxFeedTick,
  toEpochMilliseconds
} from './upstox-timestamp.mjs';

const now = Date.parse('2026-11-26T00:00:00.000Z');
const iso = new Date(now).toISOString();

test('converts Upstox seconds, milliseconds, microseconds, nanoseconds and ISO timestamps', () => {
  const cases = [
    now / 1000,
    now,
    now * 1000,
    now * 1e6,
    iso
  ];

  for (const value of cases) {
    assert.equal(toEpochMilliseconds(value), now, String(value));
  }
});

test('normalizes a provider tick using the envelope timestamp first', () => {
  const tick = normalizeUpstoxFeedTick(
    'NIFTY 50',
    { ltp: '26123.45', ltt: now - 5000 },
    now,
    now
  );

  assert.deepEqual(tick, {
    symbol: 'NIFTY 50',
    price: 26123.45,
    asOf: iso
  });
});

test('falls back to instrument trade time only when envelope timestamp is malformed', () => {
  const tick = normalizeUpstoxFeedTick(
    'BANKNIFTY',
    { ltp: 58000, ltt: now },
    'not-a-provider-time',
    now
  );

  assert.equal(tick?.asOf, iso);
});

test('does not fabricate a timestamp when provider timestamps are missing', () => {
  assert.equal(normalizeUpstoxFeedTick('NIFTY 50', { ltp: 26000 }, null, now), null);
  assert.equal(normalizeUpstoxFeedTick('NIFTY 50', { ltp: 26000, ltt: 'invalid' }, undefined, now), null);
});

test('rejects invalid prices, invalid symbols, pre-2000 timestamps and far-future timestamps', () => {
  for (const price of [0, -1, NaN, Infinity, 'not-a-price']) {
    assert.equal(
      normalizeUpstoxFeedTick('NIFTY 50', { ltp: price, ltt: now }, null, now),
      null,
      String(price)
    );
  }

  assert.equal(normalizeUpstoxFeedTick('', { ltp: 100, ltt: now }, null, now), null);
  assert.equal(normalizeUpstoxFeedTick('NIFTY 50', { ltp: 100, ltt: '1999-12-31T23:59:59Z' }, null, now), null);
  assert.equal(normalizeUpstoxFeedTick('NIFTY 50', { ltp: 100, ltt: now + 60001 }, null, now), null);
});

test('uses a valid provider trade timestamp when envelope timestamp is absent', () => {
  const tick = normalizeUpstoxFeedTick(
    'FINNIFTY',
    { ltp: 24000, ltt: now / 1000 },
    undefined,
    now
  );

  assert.equal(tick?.asOf, iso);
});
