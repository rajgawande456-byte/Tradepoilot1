// Upstox V3 timestamps can be represented as seconds, milliseconds,
// microseconds, nanoseconds, or an ISO date string. Convert them to epoch
// milliseconds without ever substituting the local receipt time.
export function toEpochMilliseconds(value) {
  if (value == null || value === '') return NaN;

  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return NaN;

  if (numeric >= 1e17) return numeric / 1e6; // nanoseconds -> milliseconds
  if (numeric >= 1e14) return numeric / 1e3; // microseconds -> milliseconds
  if (numeric >= 1e11) return numeric;       // already milliseconds
  if (numeric >= 1e9) return numeric * 1e3;  // seconds -> milliseconds
  return NaN;
}

export function normalizeUpstoxFeedTick(symbol, ltpc, currentTs, nowMs = Date.now()) {
  const price = Number(ltpc?.ltp);
  let timestampMs = toEpochMilliseconds(currentTs);

  // The feed envelope timestamp is preferred. Use the instrument trade
  // timestamp only when the envelope value is missing or malformed.
  if (!Number.isFinite(timestampMs)) {
    timestampMs = toEpochMilliseconds(ltpc?.ltt);
  }

  if (
    typeof symbol !== 'string' ||
    !symbol.trim() ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(timestampMs) ||
    timestampMs < Date.UTC(2000, 0, 1) ||
    timestampMs > Number(nowMs) + 60000
  ) {
    return null;
  }

  return {
    symbol: symbol.trim(),
    price,
    asOf: new Date(timestampMs).toISOString()
  };
}
