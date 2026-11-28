import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from './market/provider.mjs';

test('Upstox history normalizes candles, sends bearer auth, and identifies historical data', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl, capturedHeaders;
  globalThis.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedHeaders = options.headers;
    return {
      ok: true,
      json: async () => ({ data: { candles: [
        ['2026-11-23T09:15:00+05:30', 100, 105, 99, 104, 1200, 0],
        ['2026-11-23T09:20:00+05:30', 104, 107, 103, 106, 1500, 0]
      ] } })
    };
  };
  try {
    const provider = createProvider({ MARKET_DATA_PROVIDER: 'UPSTOX', UPSTOX_ACCESS_TOKEN: 'test-token' });
    const history = await provider.getHistory('NIFTY 50', '5');
    assert.match(capturedUrl, /historical-candle\/intraday/);
    assert.equal(capturedHeaders.Authorization, 'Bearer test-token');
    assert.equal(history.live, false);
    assert.equal(history.dataType, 'historical_candles');
    assert.equal(history.asOf, new Date(Date.parse('2026-11-23T09:20:00+05:30')).toISOString());
    assert.ok(Number.isFinite(Date.parse(history.receivedAt)));
    assert.equal(history.candles.length, 2);
    assert.equal(history.candles[0].open, 100);
    assert.equal(history.candles[1].close, 106);
    assert.ok(Number.isFinite(history.candles[0].time));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('history rejects unsupported intervals before network call', async () => {
  const provider = createProvider({ MARKET_DATA_PROVIDER: 'UPSTOX', UPSTOX_ACCESS_TOKEN: 'test-token' });
  await assert.rejects(provider.getHistory('NIFTY 50', '7'), { code: 'INTERVAL_NOT_ALLOWED' });
});

test('history rejects symbols outside allow-list', async () => {
  const provider = createProvider({ MARKET_DATA_PROVIDER: 'UPSTOX', UPSTOX_ACCESS_TOKEN: 'test-token' });
  await assert.rejects(provider.getHistory('RELIANCE', '5'), { code: 'SYMBOL_NOT_ALLOWED' });
});

test('serves a clearly marked recent historical cache during a temporary upstream outage', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const baseNow = Date.parse('2026-11-28T07:00:00.000Z');
  let now = baseNow;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ data: { candles: [
          ['2026-11-23T09:15:00+05:30', 100, 105, 99, 104, 1200, 0],
          ['2026-11-23T09:20:00+05:30', 104, 107, 103, 106, 1500, 0]
        ] } })
      };
    }
    return { ok: false, status: 503, text: async () => 'temporarily unavailable' };
  };

  try {
    const provider = createProvider({ MARKET_DATA_PROVIDER: 'UPSTOX', UPSTOX_ACCESS_TOKEN: 'test-token' });
    const fresh = await provider.getHistory('NIFTY 50', '5');
    now += 31_000;
    const fallback = await provider.getHistory('NIFTY 50', '5');

    assert.equal(fresh.stale, false);
    assert.equal(fresh.cacheStatus, 'fresh');
    assert.equal(fallback.stale, true);
    assert.equal(fallback.cacheStatus, 'stale_fallback');
    assert.equal(fallback.live, false);
    assert.equal(fallback.asOf, fresh.asOf);
    assert.equal(fallback.receivedAt, fresh.receivedAt);
    assert.equal(fallback.cacheAgeMs, 31_000);
    assert.equal(fallback.staleReason, 'UPSTOX_HISTORY_ERROR');
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test('does not serve a historical cache beyond the stale fallback limit', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const baseNow = Date.parse('2026-11-28T07:00:00.000Z');
  let now = baseNow;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ data: { candles: [
          ['2026-11-23T09:15:00+05:30', 100, 105, 99, 104, 1200, 0],
          ['2026-11-23T09:20:00+05:30', 104, 107, 103, 106, 1500, 0]
        ] } })
      };
    }
    return { ok: false, status: 503, text: async () => 'temporarily unavailable' };
  };

  try {
    const provider = createProvider({ MARKET_DATA_PROVIDER: 'UPSTOX', UPSTOX_ACCESS_TOKEN: 'test-token' });
    await provider.getHistory('NIFTY 50', '5');
    now += 6 * 60 * 1000;
    await assert.rejects(
      provider.getHistory('NIFTY 50', '5'),
      { code: 'UPSTOX_HISTORY_ERROR' }
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

