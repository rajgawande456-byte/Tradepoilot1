const MIN_CANDLE_TIME_SECONDS = Math.floor(Date.UTC(2000, 0, 1) / 1000);
const DEFAULT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Upstox V3 historical candles are [timestamp, open, high, low, close, volume, oi].
// Only normalize values that match that provider shape; never fill missing prices.
function parseCandleTime(value) {
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value.trim()))
  ) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return NaN;
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }

  if (typeof value !== 'string' || !value.trim()) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
}

function parseFiniteNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    return NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function normalizeUpstoxCandles(
  rows,
  {
    nowMs = Date.now(),
    futureToleranceMs = DEFAULT_FUTURE_TOLERANCE_MS
  } = {}
) {
  const now = Number(nowMs);
  if (!Array.isArray(rows) || !Number.isFinite(now)) return [];

  const tolerance = Number(futureToleranceMs);
  const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0
    ? tolerance
    : DEFAULT_FUTURE_TOLERANCE_MS;
  const latestAllowedTime = Math.floor((now + safeTolerance) / 1000);
  const uniqueByTime = new Map();

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;

    const time = parseCandleTime(row[0]);
    if (
      !Number.isFinite(time) ||
      time < MIN_CANDLE_TIME_SECONDS ||
      time > latestAllowedTime
    ) {
      continue;
    }

    const open = parseFiniteNumber(row[1]);
    const high = parseFiniteNumber(row[2]);
    const low = parseFiniteNumber(row[3]);
    const close = parseFiniteNumber(row[4]);
    const volume = parseFiniteNumber(row[5]);
    const oi = row[6] == null ? null : parseFiniteNumber(row[6]);

    if (
      ![open, high, low, close, volume].every(Number.isFinite) ||
      [open, high, low, close].some(value => value <= 0) ||
      volume < 0 ||
      (oi !== null && (!Number.isFinite(oi) || oi < 0)) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      high < low
    ) {
      continue;
    }

    // A later valid row for the same candle time supersedes an earlier copy.
    uniqueByTime.set(time, { time, open, high, low, close, volume, oi });
  }

  return [...uniqueByTime.values()].sort((a, b) => a.time - b.time);
}
