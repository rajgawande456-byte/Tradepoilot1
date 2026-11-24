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
      const historyResponse = await fetch(historyUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
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

    const parseCandleTime = value => {
      if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return NaN;
        return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
      }
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
    };
    const rowsWithShape = candles.filter(row => Array.isArray(row) && row.length >= 6);
    const normalized = rowsWithShape.map(row => ({
      time: parseCandleTime(row[0]),
      open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
      close: Number(row[4]), volume: Number(row[5] ?? 0),
      oi: row[6] == null || !Number.isFinite(Number(row[6])) || Number(row[6]) < 0 ? null : Number(row[6])
    }));
    const validCandles = normalized.filter(c =>
      Number.isFinite(c.time) &&
      [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
      c.volume >= 0 &&
      c.high >= Math.max(c.open,c.close) &&
      c.low <= Math.min(c.open,c.close) &&
      c.high >= c.low
    );
    const uniqueByTime = new Map();
    for (const candle of validCandles) uniqueByTime.set(candle.time, candle);
    const cleanCandles = [...uniqueByTime.values()].sort((a,b) => a.time-b.time);
    if (!cleanCandles.length) {
      throw new MarketDataProviderError('UPSTOX_HISTORY_INVALID', `Historical candle validation failed: received ${candles.length} rows, ${rowsWithShape.length} rows with expected shape, ${validCandles.length} valid rows.`, 502);
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
