const ALLOWED_SYMBOLS = new Set([
  'NIFTY 50',
  'BANKNIFTY',
  'FINNIFTY'
]);

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

function createUnconfiguredProvider() {
  return null;
}

export function createProvider(env = process.env) {
  const providerName = String(env.MARKET_DATA_PROVIDER || '').trim();

  if (!providerName) {
    return createUnconfiguredProvider();
  }

  throw new MarketDataProviderError(
    'MARKET_DATA_PROVIDER_UNSUPPORTED',
    `Unsupported market-data provider: ${providerName}.`
  );
}
