export function chartContextKey(symbol, interval) {
  const safeSymbol = String(symbol ?? '').trim();
  const safeInterval = String(interval ?? '').trim();
  return safeSymbol && safeInterval ? safeSymbol + ':' + safeInterval : '';
}

export function canReuseChartData(loadedContextKey, requestedContextKey, hasCandles) {
  return Boolean(
    hasCandles &&
    typeof loadedContextKey === 'string' &&
    loadedContextKey.length > 0 &&
    loadedContextKey === requestedContextKey
  );
}

// The dashboard's classic script calls this after DOMContentLoaded. Module
// scripts execute before that event, so the helper is available before the
// first chart request.
if (typeof window !== 'undefined') {
  window.TradePilotChartContext = { chartContextKey, canReuseChartData };
}
