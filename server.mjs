import http from 'node:http';
import crypto from 'node:crypto';

import {
  createProvider,
  MarketDataProviderError
} from './market/provider.mjs';

import {
  createMarketStream
} from './market/stream.mjs';

import {
  isWebSocketUpgrade,
  upgradeResponseHeaders,
  createWebSocketClient,
  verifyWebSocketAccess
} from './market/ws-transport.mjs';

import {
  handleAuthRequest
} from './auth/routes.mjs';

import {
  isDatabaseConfigured,
  checkDatabaseConnection
} from './db/client.mjs';

const PORT = Number(
  process.env.PORT || 8787
);

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const MARKET_DATA_PROVIDER =
  process.env.MARKET_DATA_PROVIDER || '';

const WS_AUTH_TOKEN =
  process.env.WS_AUTH_TOKEN || '';

const VERSION = '1.3.0';

let marketProvider = null;

try {
  marketProvider = createProvider(
    process.env
  );
} catch {
  marketProvider = null;
}

const marketStream =
  createMarketStream({
    provider: marketProvider,
    maxAgeMs: Number(
      process.env.MARKET_DATA_MAX_AGE_MS ||
      15000
    )
  });

const rate = new Map();

function json(
  res,
  status,
  body,
  extra = {}
) {
  const data = JSON.stringify(body);

  res.writeHead(status, {
    'content-type':
      'application/json; charset=utf-8',

    'content-length':
      Buffer.byteLength(data),

    'cache-control':
      'no-store',

    'x-content-type-options':
      'nosniff',

    'x-frame-options':
      'DENY',

    'referrer-policy':
      'no-referrer',

    'content-security-policy':
      "default-src 'none'; frame-ancestors 'none'",

    'strict-transport-security':
      process.env.NODE_ENV === 'production'
        ? 'max-age=31536000; includeSubDomains'
        : 'max-age=0',

    ...extra
  });

  res.end(data);
}

function originHeaders(req) {
  const origin = req.headers.origin;

  if (
    !origin ||
    !ALLOWED_ORIGINS.size
  ) {
    return {};
  }

  if (!ALLOWED_ORIGINS.has(origin)) {
    return {};
  }

  return {
    'access-control-allow-origin':
      origin,

    'access-control-allow-credentials':
      'true',

    vary: 'Origin'
  };
}

function allowed(req) {
  const key =
    `${req.socket.remoteAddress || 'unknown'}:` +
    `${Math.floor(Date.now() / 60000)}`;

  const count =
    (rate.get(key) || 0) + 1;

  rate.set(key, count);

  return count <= Number(
    process.env.RATE_LIMIT_PER_MINUTE ||
    120
  );
}

function requestId() {
  return crypto.randomUUID();
}

const server = http.createServer(
  async (req, res) => {
    const headers =
      originHeaders(req);

    const id = requestId();

    res.setHeader(
      'x-request-id',
      id
    );

    if (req.method === 'OPTIONS') {
      return json(
        res,
        204,
        {},
        {
          ...headers,

          'access-control-allow-methods':
            'GET,POST,PATCH,DELETE,OPTIONS',

          'access-control-allow-headers':
            'content-type, authorization, idempotency-key'
        }
      );
    }

    if (!allowed(req)) {
      return json(
        res,
        429,
        {
          error: 'RATE_LIMITED',
          requestId: id
        },
        headers
      );
    }

    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    );

    /*
     * Authentication
     *
     * POST /api/v1/auth/signup
     * POST /api/v1/auth/login
     * POST /api/v1/auth/logout
     * GET  /api/v1/me
     */
    const authResponse =
      await handleAuthRequest(req);

    if (authResponse) {
      return json(
        res,
        authResponse.status,
        {
          ...authResponse.body,
          requestId: id
        },
        {
          ...headers,
          ...(authResponse.headers || {})
        }
      );
    }

    /*
     * API health
     *
     * This checks the actual PostgreSQL
     * connection when DATABASE_URL exists.
     */
    if (
      url.pathname === '/health' &&
      req.method === 'GET'
    ) {
      let database =
        'not_configured';

      if (
        isDatabaseConfigured()
      ) {
        try {
          await checkDatabaseConnection();

          database =
            'connected';
        } catch {
          database =
            'unavailable';
        }
      }

      const healthy =
        database === 'connected' ||
        database === 'not_configured';

      return json(
        res,
        healthy ? 200 : 503,
        {
          ok: healthy,

          service:
            'tradepilot-api',

          version:
            VERSION,

          database,

          requestId:
            id
        },
        headers
      );
    }

    /*
     * Market snapshot
     */
    if (
      url.pathname ===
        '/api/v1/market/snapshot' &&
      req.method === 'GET'
    ) {
      if (!marketProvider) {
        return json(
          res,
          503,
          {
            error:
              'MARKET_DATA_NOT_CONFIGURED',

            message:
              'No
