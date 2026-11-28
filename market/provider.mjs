import { assessUpstoxSnapshotFreshness } from './upstox-snapshot-freshness.mjs';
import { normalizeUpstoxCandles } from './upstox-candles.mjs';

const ALLOWED_SYMBOLS = new Set([
  'NIFTY 50',
  'BANKNIFTY',
  'FINNIFTY'
]);

const INSTRUMENT_KEYS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANKNIFTY': 'NSE_INDEX|Nifty Bank',
  'FINNIFTY': 'NSE_INDEX|Nifty Fin Service'
};

export class MarketDataProviderError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'MarketDataProviderError';
    this.code = code;
    this.status = status;
  }
}

function validateSymbol(symbol) {
  const value = String(symbol || '').trim();

  if (!ALLOWED_SYMBOLS.has(value)) {
    throw new MarketDataProviderError(
      'SYMBOL_NOT_ALLOWED',
      'Requested market symbol is not allow-listed.',
      403
    );
  }

  return value;
}

function createUpstoxProvider(env) {
  const token = String(env.UPSTOX_ACCESS_TOKEN || '').trim();

  if (!token) {
    throw new MarketDataProviderError(
      'UPSTOX_TOKEN_MISSING',
      'Upstox access token is not configured.'
    );
  }

  const snapshotCache = new Map();
  const historyCache = new Map();
  const inFlight = new Map();
  const MAX_STALE_HISTORY_CACHE_MS = 5 * 60 * 1000;

  // Serialize historical-candle requests so simultaneous index/timeframe loads
  // do not burst the Upstox historical API. Retry HTTP 429 using Retry-After.
  let historyRequestQueue = Promise.resolve();
  let lastHistoryRequestAt = 0;

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function fetchHistoryWithThrottle(url, safeSymbol, endpointLabel) {
    const task = historyRequestQueue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const spacing = 1100 - (Date.now() - lastHistoryRequestAt);
        if (spacing > 0) await wait(spacing);
        lastHistoryRequestAt = Date.now();

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`
          },
          signal: AbortSignal.timeout(10000)
        });

        if (response.status !== 429) return response;

        const body = await response.text().catch(() => '');
        if (attempt === 2) {
          console.error('Upstox historical rate limit persisted', {
            symbol: safeSymbol,
            endpoint: endpointLabel,
            status: response.status,
            body: body.slice(0, 300)
          });
          throw new MarketDataProviderError(
            'UPSTOX_HISTORY_RATE_LIMITED',
            'Upstox historical data is temporarily rate limited. Please retry shortly.',
            503
          );
        }

        const retryAfter = response.headers?.get?.('retry-after');
        let retryMs = Number(retryAfter) * 1000;
        if (!Number.isFinite(retryMs) || retryMs <= 0) {
          const retryDate = Date.parse(retryAfter || '');
          retryMs = Number.isFinite(retryDate)
            ? retryDate - Date.now()
            : 1500 * (2 ** attempt);
        }
        await wait(Math.max(1000, Math.min(retryMs, 10000)));
      }
      throw new MarketDataProviderError(
        'UPSTOX_HISTORY_RATE_LIMITED',
        'Upstox historical data is temporarily rate limited. Please retry shortly.',
        503
      );
    });

    historyRequestQueue = task.catch(() => {});
    return task;
  }

  async function getSnapshotRemote(symbol) {
    const safeSymbol = validateSymbol(symbol);
    const instrumentKey = INSTRUMENT_KEYS[safeSymbol];

    const url = new URL(
      'https://api.upstox.com/v2/market-quote/quotes'
    );

    url.searchParams.set('instrument_key', instrumentKey);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const upstreamBody = await response.text().catch(() => '');
      // Log only the upstream error body; never log request headers or access tokens.
      console.error('Upstox snapshot upstream error', {
        status: response.status,
        symbol: safeSymbol,
        body: upstreamBody.slice(0, 500)
      });
      throw new MarketDataProviderError(
        'UPSTOX_API_ERROR',
        `Upstox returned HTTP ${response.status}.`,
        502
      );
    }

    const result = await response.json();

    if (!result || !result.data) {
      throw new MarketDataProviderError(
        'UPSTOX_EMPTY_RESPONSE',
        'No market data received from Upstox.',
        502
      );
    }

    const normalizedInstrumentKey = instrumentKey.replace('|', ':');
    const quote = result.data[instrumentKey] || result.data[normalizedInstrumentKey] || Object.entries(result.data).find(([key, entry]) => key === normalizedInstrumentKey || key.replace(':', '|') === instrumentKey || (entry && (entry.instrument_token === instrumentKey || entry.instrument_key === instrumentKey)))?.[1];

    if (!quote) {
      const returnedKeys = Object.keys(result.data);
      console.error('Upstox snapshot quote lookup miss', {
        symbol: safeSymbol,
        requestedInstrumentKey: instrumentKey,
        returnedKeys: returnedKeys.slice(0, 20),
        returnedInstrumentTokens: Object.values(result.data)
          .filter(entry => entry && typeof entry === 'object')
          .map(entry => entry.instrument_token)
          .filter(value => value != null)
          .slice(0, 20)
      });
      throw new MarketDataProviderError(
        'QUOTE_NOT_FOUND',
        'Quote was not found for the requested instrument.',
        502
      );
    }

    const lastPrice = Number(quote.last_price);
    const ohlc = quote.ohlc || {};
    const parsedOHLC = {
      open: ohlc.open == null ? null : Number(ohlc.open),
      high: ohlc.high == null ? null : Number(ohlc.high),
      low: ohlc.low == null ? null : Number(ohlc.low),
      close: ohlc.close == null ? null : Number(ohlc.close)
    };
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      throw new MarketDataProviderError(
        'QUOTE_PRICE_INVALID',
        'Quote last price is missing or invalid.',
        502
      );
    }
    const volume = quote.volume == null ? null : Number(quote.volume);
    const averagePrice = quote.average_price == null ? null : Number(quote.average_price);
    const netChange = quote.net_change == null ? null : Number(quote.net_change);
    if ((volume !== null && (!Number.isFinite(volume) || volume < 0)) ||
      (averagePrice !== null && (!Number.isFinite(averagePrice) || averagePrice <= 0)) ||
      (netChange !== null && !Number.isFinite(netChange))) {
      throw new MarketDataProviderError(
        'QUOTE_METADATA_INVALID',
        'Quote volume or metadata failed validation.',
        502
      );
    }
    const presentOHLC = Object.values(parsedOHLC).filter(value => value !== null);
    if (presentOHLC.some(value => !Number.isFinite(value) || value <= 0) ||
      (parsedOHLC.high !== null && parsedOHLC.low !== null && parsedOHLC.high < parsedOHLC.low) ||
      (parsedOHLC.high !== null && parsedOHLC.open !== null && parsedOHLC.high < parsedOHLC.open) ||
      (parsedOHLC.high !== null && parsedOHLC.close !== null && parsedOHLC.high < parsedOHLC.close) ||
      (parsedOHLC.low !== null && parsedOHLC.open !== null && parsedOHLC.low > parsedOHLC.open) ||
      (parsedOHLC.low !== null && parsedOHLC.close !== null && parsedOHLC.low > parsedOHLC.close)) {
      throw new MarketDataProviderError(
        'QUOTE_OHLC_INVALID',
        'Quote OHLC values failed validation.',
        502
      );
    }

    const freshness = assessUpstoxSnapshotFreshness(
      quote.last_trade_time ?? quote.timestamp ?? null
    );

    return {
      symbol: safeSymbol,
      instrumentKey,
      provider: 'UPSTOX',
      live: freshness.live,
      lastPrice,
      open: parsedOHLC.open,
      high: parsedOHLC.high,
      low: parsedOHLC.low,
      close: parsedOHLC.close,
      volume,
      averagePrice,
      netChange,
      timestamp: freshness.timestamp,
      freshnessMs: freshness.freshnessMs,
      freshnessStatus: freshness.freshnessStatus,
      receivedAt: new Date().toISOString(),
      raw: quote
    };
  }

  async function getHistoryRemote(symbol, interval = '5') {
    const safeSymbol = validateSymbol(symbol);
    const allowedIntervals = new Set(['1', '2', '3', '5', '10', '15', '30', '60', '120', '240']);
    const safeInterval = String(interval);
    if (!allowedIntervals.has(safeInterval)) {
      throw new MarketDataProviderError('INTERVAL_NOT_ALLOWED', 'Unsupported candle interval.', 400);
    }
    const instrumentKey = INSTRUMENT_KEYS[safeSymbol];
    const isHour = ['60', '120', '240'].includes(safeInterval);
    const unit = isHour ? 'hours' : 'minutes';
    const providerInterval = isHour ? String(Number(safeInterval) / 60) : safeInterval;
    const url = new URL('https://api.upstox.com/v3/historical-candle/intraday/' + encodeURIComponent(instrumentKey) + '/' + unit + '/' + providerInterval);
    const response = await fetchHistoryWithThrottle(url, safeSymbol, 'intraday');
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('Upstox historical upstream error', {
        status: response.status, symbol: safeSymbol, body: body.slice(0, 300)
      });
      throw new MarketDataProviderError('UPSTOX_HISTORY_ERROR', `Upstox historical candles returned HTTP ${response.status}.`, 502);
    }
    let result = await response.json();
    let candles = result?.data?.candles;
    if (!Array.isArray(candles)) {
      throw new MarketDataProviderError('UPSTOX_HISTORY_EMPTY', 'Historical candle data is missing.', 502);
    }

    // Intraday V3 only returns the current trading day's candles. If it returns
    // an empty array, fall back to a recent date range so the chart can still load.
    if (candles.length === 0) {
      const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      const part = type => dateParts.find(item => item.type === type)?.value;
      const toDate = `${part('year')}-${part('month')}-${part('day')}`;
      const from = new Date(`${toDate}T00:00:00+05:30`);
      from.setUTCDate(from.getUTCDate() - 7);
      const fromDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(from);
      const historyUrl = new URL(
        'https://api.upstox.com/v3/historical-candle/' +
        encodeURIComponent(instrumentKey) + '/' + unit + '/' + providerInterval +
        '/' + toDate + '/' + fromDate
      );
      const historyResponse = await fetchHistoryWithThrottle(historyUrl, safeSymbol, 'date-range');
      if (historyResponse.ok) {
        result = await historyResponse.json();
        candles = result?.data?.candles;
      } else {
        const body = await historyResponse.text().catch(() => '');
        console.error('Upstox historical fallback error', {
          status: historyResponse.status, symbol: safeSymbol, body: body.slice(0, 400)
        });
      }
      if (!Array.isArray(candles)) {
        throw new MarketDataProviderError('UPSTOX_HISTORY_EMPTY', 'Intraday and date-range historical candle data are unavailable.', 502);
      }
    }

    const cleanCandles = normalizeUpstoxCandles(candles);
    if (!cleanCandles.length) {
      throw new MarketDataProviderError(
        'UPSTOX_HISTORY_INVALID',
        `Historical candle validation failed: received ${candles.length} rows and no valid candles.`,
        502
      );
    }
    const latestCandle = cleanCandles[cleanCandles.length - 1];
    return {
      symbol: safeSymbol,
      instrumentKey,
      provider: 'UPSTOX',
      dataType: 'historical_candles',
      live: false,
      interval: safeInterval,
      asOf: new Date(latestCandle.time * 1000).toISOString(),
      receivedAt: new Date().toISOString(),
      candles: cleanCandles
    };
  }

  async function cachedRequest(key, cache, ttlMs, loader) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = loader().then(value => {
      cache.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  function getSnapshot(symbol) {
    const safeSymbol = validateSymbol(symbol);
    return cachedRequest('snapshot:' + safeSymbol, snapshotCache, 2000,
      () => getSnapshotRemote(safeSymbol));
  }

  async function getHistory(symbol, interval = '5') {
    const safeSymbol = validateSymbol(symbol);
    const safeInterval = String(interval);
    const key = 'history:' + safeSymbol + ':' + safeInterval;

    try {
      const value = await cachedRequest(
        key,
        historyCache,
        30000,
        () => getHistoryRemote(safeSymbol, safeInterval)
      );
      const cached = historyCache.get(key);
      return {
        ...value,
        stale: false,
        cacheStatus: 'fresh',
        cacheAgeMs: cached ? Math.max(0, Date.now() - cached.at) : 0
      };
    } catch (error) {
      const status = Number(error?.status);
      const networkCodes = new Set([
        'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'
      ]);
      const networkCode = error?.code || error?.cause?.code;
      const transientFailure =
        (Number.isFinite(status) && status >= 500 && status <= 599) ||
        ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name) ||
        networkCodes.has(networkCode);

      const cached = historyCache.get(key);
      const cacheAgeMs = cached
        ? Math.max(0, Date.now() - cached.at)
        : Infinity;

      // Keep a recent, previously validated historical chart available during
      // transient provider outages, but never relabel it as live or refresh its
      // original asOf/receivedAt timestamps.
      if (
        !transientFailure ||
        !cached ||
        cacheAgeMs > MAX_STALE_HISTORY_CACHE_MS
      ) {
        throw error;
      }

      return {
        ...cached.value,
        live: false,
        stale: true,
        cacheStatus: 'stale_fallback',
        cacheAgeMs,
        staleReason: error?.code || 'UPSTREAM_UNAVAILABLE'
      };
    }
  }

  return {
    getSnapshot,
    snapshot: getSnapshot,
    getHistory
  };
}

export function createProvider(env = process.env) {
  const providerName = String(
    env.MARKET_DATA_PROVIDER || ''
  ).trim().toUpperCase();

  if (!providerName) {
    return null;
  }

  if (providerName === 'UPSTOX') {
    return createUpstoxProvider(env);
  }

  throw new MarketDataProviderError(
    'MARKET_DATA_PROVIDER_UNSUPPORTED',
    `Unsupported market-data provider: ${providerName}.`
  );
}
