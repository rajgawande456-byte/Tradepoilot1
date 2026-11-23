
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProvider } from './market/provider.mjs';
import {
  createMarketStream,
  isAllowedSymbol
} from './market/stream.mjs';
import {
  isWebSocketUpgrade,
  upgradeResponseHeaders,
  createWebSocketClient,
  verifyWebSocketAccess
} from './market/ws-transport.mjs';
import { handleAuthRequest } from './auth/routes.mjs';
import {
  isDatabaseConfigured,
  checkDatabaseConnection
} from './db/client.mjs';

const PORT = Number(process.env.PORT || 8787);
const VERSION = '1.3.1';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function serveStaticFile(req, res, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const relativePath =
    decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');

  const filePath = path.resolve(ROOT_DIR, relativePath);

  if (
    !filePath.startsWith(ROOT_DIR + path.sep) &&
    filePath !== path.join(ROOT_DIR, 'index.html')
  ) {
    return false;
  }

  let stat;
  let realFilePath;
  let realRootPath;
  try {
    stat = fs.statSync(filePath);
    realFilePath = fs.realpathSync(filePath);
    realRootPath = fs.realpathSync(ROOT_DIR);
  } catch {
    return false;
  }

  // Prevent symlinks inside the static directory from exposing files outside it.
  if (
    realFilePath !== realRootPath &&
    !realFilePath.startsWith(realRootPath + path.sep)
  ) {
    return false;
  }

  if (!stat.isFile()) return false;

  res.writeHead(200, {
    'content-type':
      MIME_TYPES[path.extname(filePath).toLowerCase()] ||
      'application/octet-stream',
    'content-length': stat.size,
    'cache-control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()'
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  fs.createReadStream(filePath).pipe(res);
  return true;
}

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN || '';

const configuredRateLimit = Number(
  process.env.RATE_LIMIT_PER_MINUTE
);
const RATE_LIMIT = Number.isFinite(configuredRateLimit) && configuredRateLimit > 0
  ? Math.max(1, Math.floor(configuredRateLimit))
  : 120;

const MARKET_DATA_PROVIDER =
  process.env.MARKET_DATA_PROVIDER || '';

let marketProvider = null;

try {
  marketProvider = createProvider(process.env);
} catch (error) {
  console.error(
    'Market provider initialization failed:',
    error.message
  );
}

const marketStream = createMarketStream({
  provider: marketProvider,
  maxAgeMs: Number(
    process.env.MARKET_DATA_MAX_AGE_MS || 15000
  )
});

const rate = new Map();

function requestId() {
  return crypto.randomUUID();
}

function getCorsHeaders(req) {
  const origin = req.headers.origin;

  if (!origin || !ALLOWED_ORIGINS.size) {
    return {};
  }

  if (!ALLOWED_ORIGINS.has(origin)) {
    return {};
  }

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin'
  };
}

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent || res.destroyed) {
    return;
  }

  const data = JSON.stringify(body);

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; frame-ancestors 'none'",
    ...extra
  });

  res.end(data);
}

function isRateLimited(req) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const key = `${req.socket.remoteAddress || 'unknown'}:${minute}`;

  const count = (rate.get(key) || 0) + 1;
  rate.set(key, count);

  if (rate.size > 5000) {
    for (const entry of rate.keys()) {
      if (!entry.endsWith(`:${minute}`)) {
        rate.delete(entry);
      }
    }
    // Bound memory even if many unique clients arrive within one minute.
    while (rate.size > 5000) {
      const oldest = rate.keys().next().value;
      if (oldest === undefined) break;
      rate.delete(oldest);
    }
  }

  return count > RATE_LIMIT;
}

const server = http.createServer(async (req, res) => {
  const requestID = requestId();
  const corsHeaders = getCorsHeaders(req);

  res.setHeader('x-request-id', requestID);

  try {
    if (req.method === 'OPTIONS') {
      return sendJson(
        res,
        204,
        {},
        {
          ...corsHeaders,
          'access-control-allow-methods':
            'GET,POST,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers':
            'content-type,authorization,idempotency-key'
        }
      );
    }

    if (isRateLimited(req)) {
      return sendJson(
        res,
        429,
        {
          error: 'RATE_LIMITED',
          requestId: requestID
        },
        corsHeaders
      );
    }

    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    );

    const authResponse = await handleAuthRequest(req);

    if (authResponse) {
      return sendJson(
        res,
        authResponse.status,
        {
          ...authResponse.body,
          requestId: requestID
        },
        {
          ...corsHeaders,
          ...(authResponse.headers || {})
        }
      );
    }

    // Homepage
    if (
      url.pathname === '/' &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      if (serveStaticFile(req, res, '/')) return;

      return sendJson(res, 404, {
        error: 'DASHBOARD_NOT_FOUND',
        message: 'index.html not found in repository root.',
        requestId: requestID
      }, corsHeaders);
    }

    // Frontend assets
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !url.pathname.startsWith('/api/')
    ) {
      if (serveStaticFile(req, res, url.pathname)) return;
    }

    // Health and database status
    if (url.pathname === '/health' && req.method === 'GET') {
      let database = 'not_configured';

      if (isDatabaseConfigured()) {
        try {
          await checkDatabaseConnection();
          database = 'connected';
        } catch (error) {
          database = 'unavailable';
          console.error('Database health check failed:', error.message);
        }
      }

      const healthy =
        database === 'connected' ||
        database === 'not_configured';

      return sendJson(
        res,
        healthy ? 200 : 503,
        {
          ok: healthy,
          service: 'tradepilot-api',
          version: VERSION,
          database,
          marketData: marketProvider ? 'configured' : 'not_configured',
          provider: MARKET_DATA_PROVIDER || null,
          requestId: requestID
        },
        corsHeaders
      );
    }

    // Symbols
    if (
      url.pathname === '/api/v1/market/symbols' &&
      req.method === 'GET'
    ) {
      return sendJson(
        res,
        200,
        {
          symbols: ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY'],
          providerConfigured: Boolean(marketProvider),
          requestId: requestID
        },
        corsHeaders
      );
    }

    // Market snapshot
    if (
      url.pathname === '/api/v1/market/snapshot' &&
      req.method === 'GET'
    ) {
      const symbol = String(
        url.searchParams.get('symbol') || 'NIFTY 50'
      ).trim();

      if (!isAllowedSymbol(symbol)) {
        return sendJson(
          res,
          400,
          {
            error: 'SYMBOL_NOT_ALLOWED',
            message: 'Use NIFTY 50, BANKNIFTY, or FINNIFTY.',
            requestId: requestID
          },
          corsHeaders
        );
      }

      if (!marketProvider) {
        return sendJson(
          res,
          503,
          {
            error: 'MARKET_DATA_NOT_CONFIGURED',
            message: 'A working market-data provider has not been configured yet.',
            symbol,
            requestId: requestID
          },
          corsHeaders
        );
      }

      const getSnapshot =
        marketProvider.getSnapshot ||
        marketProvider.snapshot;

      if (typeof getSnapshot !== 'function') {
        return sendJson(
          res,
          503,
          {
            error: 'SNAPSHOT_NOT_SUPPORTED',
            message: 'The configured provider does not expose a snapshot method yet.',
            symbol,
            requestId: requestID
          },
          corsHeaders
        );
      }

      const snapshot = await getSnapshot.call(
        marketProvider,
        symbol
      );

      return sendJson(
        res,
        200,
        {
          symbol,
          data: snapshot,
          requestId: requestID
        },
        corsHeaders
      );
    }

    // Historical intraday candles
    if (
      url.pathname === '/api/v1/market/history' &&
      req.method === 'GET'
    ) {
      const symbol = String(url.searchParams.get('symbol') || 'NIFTY 50').trim();
      const interval = String(url.searchParams.get('interval') || '5').trim();
      if (!isAllowedSymbol(symbol)) {
        return sendJson(res, 400, {
          error: 'SYMBOL_NOT_ALLOWED',
          message: 'Use NIFTY 50, BANKNIFTY, or FINNIFTY.',
          requestId: requestID
        }, corsHeaders);
      }
      if (!marketProvider || typeof marketProvider.getHistory !== 'function') {
        return sendJson(res, 503, {
          error: 'HISTORY_NOT_CONFIGURED',
          message: 'Historical candles are not available from the configured provider.',
          symbol, interval, requestId: requestID
        }, corsHeaders);
      }
      const history = await marketProvider.getHistory(symbol, interval);
      return sendJson(res, 200, {
        symbol, interval, data: history, requestId: requestID
      }, corsHeaders);
    }

    // WebSocket endpoint
    if (
      url.pathname === '/api/v1/market/stream' &&
      req.method === 'GET'
    ) {
      return sendJson(
        res,
        426,
        {
          error: 'WEBSOCKET_REQUIRED',
          message: 'Connect using a WebSocket client.',
          requestId: requestID
        },
        corsHeaders
      );
    }

    return sendJson(
      res,
      404,
      {
        error: 'NOT_FOUND',
        message: 'API route not found.',
        requestId: requestID
      },
      corsHeaders
    );
  } catch (error) {
    console.error('Request failed:', error);

    return sendJson(
      res,
      Number(error.status) >= 400 && Number(error.status) <= 599
        ? Number(error.status)
        : 500,
      {
        error: error.code || 'INTERNAL_SERVER_ERROR',
        message:
          Number(error.status) >= 400
            ? error.message
            : 'An internal server error occurred.',
        requestId: requestID
      },
      corsHeaders
    );
  }
});

// WebSocket market stream
server.on('upgrade', (req, socket, head) => {
  let cleanup = null;
  let client = null;

  try {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    );

    if (url.pathname !== '/api/v1/market/stream') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    if (!isWebSocketUpgrade(req)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }

    if (!marketProvider) {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'
      );
      return;
    }

    const symbol = String(
      url.searchParams.get('symbol') || 'NIFTY 50'
    ).trim();

    if (!isAllowedSymbol(symbol)) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'
      );
      return;
    }

    verifyWebSocketAccess(req, {
      expectedToken: WS_AUTH_TOKEN
    });

    socket.write(upgradeResponseHeaders(req));

    client = createWebSocketClient(socket);
    cleanup = marketStream.addClient(client, symbol);

    socket.on('data', (data) => {
      if (data.length > 0 && data[0] === 0x88) {
        try {
          client.close();
        } catch {}
        socket.end();
      }
    });

    socket.on('close', () => {
      if (cleanup) cleanup();
    });

    socket.on('error', () => {
      if (cleanup) cleanup();
    });

    if (head && head.length > 0) {
      socket.unshift(head);
    }
  } catch (error) {
    if (cleanup) cleanup();

    if (!socket.destroyed) {
      const status = Number(error.status) || 401;
      const message =
        status === 503 ? 'Service Unavailable' :
        status === 403 ? 'Forbidden' :
        'Unauthorized';

      socket.end(
        `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`
      );
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TradePilot API listening on port ${PORT}`);
  console.log(`Version: ${VERSION}`);
  console.log(
    `Market provider: ${marketProvider ? 'configured' : 'not configured'}`
  );
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exitCode = 1;
});
