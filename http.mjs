import crypto from 'node:crypto';

const MAX_BODY_BYTES = 32 * 1024;
const SESSION_COOKIE = 'tradepilot_session';

export async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (contentType !== 'application/json') {
    const error = new Error('UNSUPPORTED_CONTENT_TYPE');
    error.code = 'UNSUPPORTED_CONTENT_TYPE';
    throw error;
  }

  const declaredLength = Number(req.headers['content-length'] || 0);

  if (declaredLength > MAX_BODY_BYTES) {
    const error = new Error('REQUEST_BODY_TOO_LARGE');
    error.code = 'REQUEST_BODY_TOO_LARGE';
    throw error;
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > MAX_BODY_BYTES) {
      const error = new Error('REQUEST_BODY_TOO_LARGE');
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  if (!raw.trim()) {
    const error = new Error('EMPTY_REQUEST_BODY');
    error.code = 'EMPTY_REQUEST_BODY';
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

export function getBearerToken(req) {
  const header = String(req.headers.authorization || '');

  if (!header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7).trim();

  return token || null;
}

export function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};

  for (const part of header.split(';')) {
    const index = part.indexOf('=');

    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (!name) continue;

    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

export function getSessionToken(req) {
  const cookies = parseCookies(req);

  return cookies[SESSION_COOKIE] || getBearerToken(req);
}

export function createSessionCookie(token, maxAgeSeconds) {
  const encoded = encodeURIComponent(token);

  const secure = process.env.NODE_ENV === 'production'
    ? '; Secure'
    : '';

  return [
    `${SESSION_COOKIE}=${encoded}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure.replace(/^/, '')
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearSessionCookie() {
  return [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Max-Age=0'
  ].join('; ');
}

export function safeCompare(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
