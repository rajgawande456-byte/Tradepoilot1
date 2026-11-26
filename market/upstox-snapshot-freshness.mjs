import { toEpochMilliseconds } from './upstox-timestamp.mjs';

const MIN_PROVIDER_TIMESTAMP = Date.UTC(2000, 0, 1);
const FUTURE_TOLERANCE_MS = 5000;
const DEFAULT_MAX_AGE_MS = 15000;

// A REST quote is considered live only when Upstox supplied a valid,
// recent market timestamp. receivedAt is deliberately not used as a fallback.
export function assessUpstoxSnapshotFreshness(
  providerTimestamp,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
) {
  const timestampMs = toEpochMilliseconds(providerTimestamp);
  const now = Number(nowMs);
  const maxAge = Number(maxAgeMs);

  if (
    !Number.isFinite(timestampMs) ||
    timestampMs < MIN_PROVIDER_TIMESTAMP ||
    !Number.isFinite(now) ||
    !Number.isFinite(maxAge) ||
    maxAge < 0 ||
    timestampMs > now + FUTURE_TOLERANCE_MS
  ) {
    return {
      live: false,
      timestamp: null,
      freshnessMs: null,
      freshnessStatus: 'timestamp_unavailable'
    };
  }

  const freshnessMs = Math.max(0, now - timestampMs);
  const live = freshnessMs <= maxAge;

  return {
    live,
    timestamp: new Date(timestampMs).toISOString(),
    freshnessMs,
    freshnessStatus: live ? 'fresh' : 'stale'
  };
}
