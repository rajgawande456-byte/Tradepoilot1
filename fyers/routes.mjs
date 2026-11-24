import crypto from 'node:crypto';
import { query } from '../db/client.mjs';
import { getSession, } from '../auth/service.mjs';
import { getSessionToken } from '../auth/http.mjs';
import { createFyersLoginUrl, exchangeFyersAuthCode } from '../market/fyres.mjs';

const pendingStates = new Map();
const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://tradepoilot1.onrender.com').replace(/\/$/, '');

function json(status, body) {
  return { status, body, headers: { 'content-type': 'application/json; charset=utf-8' } };
}

function encryptionKey() {
  const value = String(process.env.FYERS_TOKEN_ENCRYPTION_KEY || process.env.FYERS_SECRET_KEY || '');
  if (value.length < 32) {
    const error = new Error('Set FYERS_TOKEN_ENCRYPTION_KEY or a FYERS_SECRET_KEY of at least 32 characters.');
    error.code = 'FYERS_ENCRYPTION_NOT_CONFIGURED';
    throw error;
  }
  return crypto.createHash('sha256').update(value).digest();
}

function encryptToken(token) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function redirect(location) {
  return { status: 302, headers: { location, 'cache-control': 'no-store' }, body: null };
}

async function currentUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  return getSession(token);
}

export async function handleFyersRequest(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/api/v1/fyers/callback' && req.method === 'GET') {
    const state = String(url.searchParams.get('state') || '');
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (!pending || pending.expiresAt < Date.now()) {
      return redirect(FRONTEND_URL + '/?fyers=state_expired');
    }
    if (url.searchParams.get('s') !== 'ok' || !url.searchParams.get('auth_code')) {
      return redirect(FRONTEND_URL + '/?fyers=authorization_failed');
    }
    try {
      const result = await exchangeFyersAuthCode(url.searchParams.get('auth_code'));
      const encrypted = encryptToken(result.accessToken);
      await query(
        `INSERT INTO fyers_credentials (id, user_id, access_token_encrypted, token_expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
         ON CONFLICT (user_id) DO UPDATE SET
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           token_expires_at = EXCLUDED.token_expires_at,
           updated_at = NOW()`,
        [crypto.randomUUID(), pending.userId, encrypted]
      );
      return redirect(FRONTEND_URL + '/?fyers=connected');
    } catch (error) {
      console.error('FYERS callback failed:', error.code || error.message);
      return redirect(FRONTEND_URL + '/?fyers=connection_failed');
    }
  }

  if (!path.startsWith('/api/v1/fyers/')) return null;

  const user = await currentUser(req);
  if (!user) return json(401, { error: 'AUTH_REQUIRED' });

  if (path === '/api/v1/fyers/connect' && req.method === 'GET') {
    try {
      const login = createFyersLoginUrl();
      pendingStates.set(login.state, { userId: user.user_id, expiresAt: Date.now() + 10 * 60 * 1000 });
      if (pendingStates.size > 1000) {
        for (const [key, value] of pendingStates) if (value.expiresAt < Date.now()) pendingStates.delete(key);
      }
      return redirect(login.url);
    } catch (error) {
      return json(503, { error: error.code || 'FYERS_NOT_CONFIGURED', message: error.message });
    }
  }

  if (path === '/api/v1/fyers/status' && req.method === 'GET') {
    const result = await query(
      'SELECT token_expires_at FROM fyers_credentials WHERE user_id = $1 LIMIT 1',
      [user.user_id]
    );
    const row = result.rows[0];
    const connected = Boolean(row && (!row.token_expires_at || new Date(row.token_expires_at) > new Date()));
    return json(200, { data: { connected, expiresAt: row?.token_expires_at || null } });
  }

  if (path === '/api/v1/fyers/disconnect' && req.method === 'POST') {
    await query('DELETE FROM fyers_credentials WHERE user_id = $1', [user.user_id]);
    return json(200, { data: { disconnected: true } });
  }

  return json(404, { error: 'FYERS_ROUTE_NOT_FOUND' });
}
