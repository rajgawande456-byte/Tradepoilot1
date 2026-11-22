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

    const quote = Object.values(result.data)[0];

    if (!quote) {
      throw new MarketDataProviderError(
        'QUOTE_NOT_FOUND',
        'Quote was not found for the requested instrument.',
        502
      );
    }

    return {
      symbol: safeSymbol,
      instrumentKey,
      provider: 'UPSTOX',
      live: true,
      lastPrice: quote.last_price ?? null,
      open: quote.ohlc?.open ?? null,
      high: quote.ohlc?.high ?? null,
      low: quote.ohlc?.low ?? null,
      close: quote.ohlc?.close ?? null,
      volume: quote.volume ?? null,
      averagePrice: quote.average_price ?? null,
      netChange: quote.net_change ?? null,
      timestamp: quote.last_trade_time ?? quote.timestamp ?? null,
      receivedAt: new Date().toISOString(),
      raw: quote
    };
  }

  return {
    getSnapshot,
    snapshot: getSnapshot
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
