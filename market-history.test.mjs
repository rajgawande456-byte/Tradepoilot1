import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from './market/provider.mjs';

test('Upstox history normalizes intraday candles and sends bearer auth', async () => {
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
    assert.equal(history.live, true);
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
