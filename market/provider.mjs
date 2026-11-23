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

  async function getSnapshot(symbol) {
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

    const quote = result.data[instrumentKey];

    if (!quote) {
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

    return {
      symbol: safeSymbol,
      instrumentKey,
      provider: 'UPSTOX',
      live: true,
      lastPrice,
      open: parsedOHLC.open,
      high: parsedOHLC.high,
      low: parsedOHLC.low,
      close: parsedOHLC.close,
      volume,
      averagePrice,
      netChange,
      timestamp: quote.last_trade_time ?? quote.timestamp ?? null,
      receivedAt: new Date().toISOString(),
      raw: quote
    };
  }

  async function getHistory(symbol, interval = '5') {
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
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw new MarketDataProviderError('UPSTOX_HISTORY_ERROR', `Upstox historical candles returned HTTP ${response.status}.`, 502);
    }
    const result = await response.json();
    const candles = result?.data?.candles;
    if (!Array.isArray(candles)) {
      throw new MarketDataProviderError('UPSTOX_HISTORY_EMPTY', 'Historical candle data is missing.', 502);
    }
    const normalized = candles
      .filter(row => Array.isArray(row) && row.length >= 6)
      .map(row => ({
        time: Math.floor(Date.parse(row[0]) / 1000),
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
        close: Number(row[4]), volume: Number(row[5] ?? 0),
        oi: row[6] == null || !Number.isFinite(Number(row[6])) || Number(row[6]) < 0 ? null : Number(row[6])
      })).filter(c =>
      Number.isFinite(c.time) &&
      [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.volume >= 0 &&
      c.high >= Math.max(c.open,c.close) &&
      c.low <= Math.min(c.open,c.close) &&
      c.high >= c.low
    );
    const uniqueByTime = new Map();
    for (const candle of normalized) uniqueByTime.set(candle.time, candle);
    const cleanCandles = [...uniqueByTime.values()].sort((a,b) => a.time-b.time);
    if (!cleanCandles.length) {
      throw new MarketDataProviderError('UPSTOX_HISTORY_INVALID', 'Historical candle rows failed validation.', 502);
    }
    return {
      symbol: safeSymbol, instrumentKey, provider: 'UPSTOX', interval: safeInterval,
      live: true, candles: cleanCandles
    };
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
