import http from 'node:http';
import crypto from 'node:crypto';
import { createProvider, MarketDataProviderError } from './market/provider.mjs';
import { createMarketStream } from './market/stream.mjs';
import { isWebSocketUpgrade, upgradeResponseHeaders, createWebSocketClient, verifyWebSocketAccess } from './market/ws-transport.mjs';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const MARKET_DATA_PROVIDER = process.env.MARKET_DATA_PROVIDER || '';
let marketProvider = null;
try { marketProvider = createProvider(process.env); } catch (err) { marketProvider = null; }
const VERSION = '1.1.0';
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN || '';
const marketStream = createMarketStream({ provider: marketProvider, maxAgeMs: Number(process.env.MARKET_DATA_MAX_AGE_MS || 15000) });
const rate = new Map();

function json(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'strict-transport-security': process.env.NODE_ENV === 'production' ? 'max-age=31536000; includeSubDomains' : 'max-age=0',
    ...extra
  });
  res.end(data);
}

function originHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.size) return {};
  return ALLOWED_ORIGINS.has(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
    : {};
}

function allowed(req) {
  const key = `${req.socket.remoteAddress || 'unknown'}:${Math.floor(Date.now() / 60000)}`;
  const count = (rate.get(key) || 0) + 1;
  rate.set(key, count);
  return count <= Number(process.env.RATE_LIMIT_PER_MINUTE || 120);
}

function requestId() { return crypto.randomUUID(); }

const server = http.createServer(async (req, res) => {
  const headers = originHeaders(req);
  const id = requestId();
  res.setHeader('x-request-id', id);
  if (req.method === 'OPTIONS') {
    return json(res, 204, {}, { ...headers, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type, authorization, idempotency-key' });
  }
  if (!allowed(req)) return json(res, 429, { error: 'RATE_LIMITED', requestId: id }, headers);

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'tradepilot-api', version: VERSION }, headers);
  if (url.pathname === '/api/v1/market/snapshot' && req.method === 'GET') {
    if (!marketProvider) {
      return json(res, 503, { error: 'MARKET_DATA_NOT_CONFIGURED', message: 'No verified server-side market-data provider is configured. No synthetic live quote is returned.', requestId: id }, headers);
    }
    const symbol = url.searchParams.get('symbol') || 'NIFTY 50';
    try {
      const snapshot = await marketProvider.snapshot(symbol);
      return json(res, 200, { data: snapshot, requestId: id }, headers);
    } catch (err) {
      const e = err instanceof MarketDataProviderError ? err : new MarketDataProviderError('MARKET_DATA_UNAVAILABLE', 'Market data unavailable.');
      return json(res, e.status || 503, { error: e.code, message: e.message, requestId: id }, headers);
    }
  }
  if (url.pathname === '/api/v1/market/stream' && req.method === 'GET') {
    return json(res, 426, { error: 'WEBSOCKET_UPGRADE_REQUIRED', message: 'Use a WebSocket client against the production stream endpoint. HTTP polling is not a substitute for the verified stream.', requestId: id }, headers);
  }
  if (url.pathname === '/api/v1/me' && req.method === 'GET') {
    return json(res, 401, { error: 'AUTH_REQUIRED', message: 'Server-issued authentication is required.', requestId: id }, headers);
  }
  return json(res, 404, { error: 'NOT_FOUND', requestId: id }, headers);
});


server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/v1/market/stream' || !isWebSocketUpgrade(req)) { socket.destroy(); return; }
    verifyWebSocketAccess(req, { expectedToken: WS_AUTH_TOKEN });
    const symbol = url.searchParams.get('symbol') || 'NIFTY 50';
    const client = createWebSocketClient(socket);
    socket.write(upgradeResponseHeaders(req));
    const remove = marketStream.addClient(client, symbol);
    socket.on('error', remove);
    socket.on('close', remove);
    socket.on('data', buffer => {
      // Transport accepts only small text control frames in this boundary.
      // Provider data is never accepted from the browser.
      if (buffer.length > 4096) client.close(1009);
    });
  } catch { socket.destroy(); }
});

server.listen(PORT, () => console.log(`TradePilot API listening on :${PORT}`));
