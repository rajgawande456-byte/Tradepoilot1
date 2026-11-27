const SUPPORTED_INTERVALS = new Set([60, 300, 900, 3600]);
const NSE_SESSION_OPEN_UTC_SECONDS = 3 * 60 * 60 + 45 * 60; // 09:15 IST
function rejected(reason) { return { accepted: false, reason }; }

/** Validate a backend market tick and merge it into a forming OHLC candle.
 * A price-only tick has no candle volume, so volume stays null unless it
 * was already supplied by a historical candle. */
export function applyLiveTick({
  candles = [], tick, symbol, intervalSeconds, maxAgeMs = 15000,
  lastSequence = null, lastTickAtMs = null
} = {}) {
  if (!Array.isArray(candles)) return rejected('invalid_candles');
  if (typeof symbol !== 'string' || !symbol.trim()) return rejected('invalid_symbol');
  if (!SUPPORTED_INTERVALS.has(Number(intervalSeconds))) return rejected('invalid_interval');
  if (!tick || typeof tick !== 'object' || Array.isArray(tick)) return rejected('invalid_tick');
  if (tick.symbol !== symbol) return rejected('symbol_mismatch');
  if (typeof tick.provider !== 'string' || !tick.provider.trim()) return rejected('unverified_provider');
  if (!Number.isSafeInteger(tick.sequence) || tick.sequence < 0) return rejected('invalid_sequence');
  if (typeof tick.price !== 'number' || !Number.isFinite(tick.price) || tick.price <= 0) return rejected('invalid_price');
  if (typeof tick.asOf !== 'string' || !tick.asOf.trim()) return rejected('missing_timestamp');

  const timestampMs = Date.parse(tick.asOf);
  const maxAge = Number(maxAgeMs);
  const providerFreshness = tick.freshnessMs;
  if (!Number.isFinite(timestampMs)) return rejected('invalid_timestamp');
  if (!Number.isFinite(maxAge) || maxAge < 0) return rejected('invalid_freshness_window');
  if (typeof providerFreshness !== 'number' || !Number.isFinite(providerFreshness) || providerFreshness < 0) {
    return rejected('missing_freshness');
  }
  if (providerFreshness > maxAge) return rejected('stale_or_future_tick');
  const sequenceRegressed = lastSequence != null && tick.sequence < lastSequence;
  const exchangeTimeAdvanced = lastTickAtMs != null && timestampMs > lastTickAtMs;
  if (lastSequence != null && tick.sequence <= lastSequence && !(sequenceRegressed && exchangeTimeAdvanced)) {
    return rejected('out_of_order_sequence');
  }
  if (lastTickAtMs != null && timestampMs < lastTickAtMs) return rejected('out_of_order_timestamp');

  const seconds = Math.floor(timestampMs / 1000);
  const utcDayStart = Math.floor(seconds / 86400) * 86400;
  let sessionAnchor = utcDayStart + NSE_SESSION_OPEN_UTC_SECONDS;
  if (seconds < sessionAnchor) sessionAnchor -= 86400;
  const bucket = sessionAnchor + Math.floor((seconds - sessionAnchor) / Number(intervalSeconds)) * Number(intervalSeconds);
  const lastBar = candles.length ? candles[candles.length - 1] : null;
  if (lastBar && (!Number.isFinite(Number(lastBar.time)) || bucket < Number(lastBar.time))) {
    return rejected('older_than_chart');
  }

  const base = lastBar && Number(lastBar.time) === bucket ? lastBar : null;
  const candle = {
    time: bucket,
    open: base ? base.open : tick.price,
    high: Math.max(base ? base.high : tick.price, tick.price),
    low: Math.min(base ? base.low : tick.price, tick.price),
    close: tick.price,
    volume: base ? (base.volume ?? null) : null
  };
  const nextCandles = candles.slice();
  if (base) nextCandles[nextCandles.length - 1] = candle;
  else nextCandles.push(candle);

  return {
    accepted: true, candles: nextCandles, liveCandle: candle,
    lastSequence: tick.sequence, lastTickAtMs: timestampMs, price: tick.price
  };
}

if (typeof window !== 'undefined') window.TradePilotLiveCandle = { applyLiveTick };
