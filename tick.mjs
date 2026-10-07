import { MarketDataProviderError } from './provider.mjs';

export function normalizeTick(raw, providerName = 'verified-provider') {
  if (!raw || typeof raw !== 'object') throw new MarketDataProviderError('INVALID_PROVIDER_EVENT', 'Provider event must be an object.');
  const symbol = String(raw.symbol || '').trim();
  const sequence = Number(raw.sequence ?? raw.seq);
  const price = Number(raw.price ?? raw.last);
  const timestamp = Date.parse(raw.asOf || raw.timestamp || raw.ts || '');
  if (!symbol || !Number.isInteger(sequence) || sequence < 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
    throw new MarketDataProviderError('INVALID_PROVIDER_EVENT', 'Provider event failed symbol/sequence/price/timestamp validation.');
  }
  return { symbol, sequence, price, asOf: new Date(timestamp).toISOString(), provider: providerName };
}

export function validateSequenceAndFreshness(tick, previousSequence, maxAgeMs = 15000) {
  const age = Date.now() - Date.parse(tick.asOf);
  if (!Number.isFinite(age) || age < -5000 || age > maxAgeMs) {
    throw new MarketDataProviderError('STALE_MARKET_DATA', 'Provider event failed freshness validation.');
  }
  if (previousSequence != null && tick.sequence <= previousSequence) {
    throw new MarketDataProviderError('OUT_OF_ORDER_EVENT', 'Provider event sequence is not strictly increasing.');
  }
  return { ...tick, freshnessMs: Math.max(0, age) };
}
