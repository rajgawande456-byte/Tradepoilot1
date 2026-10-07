import crypto from 'node:crypto';
import argon2 from 'argon2';

import {
  query,
  isDatabaseConfigured
} from '../db/client.mjs';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();

  if (!value || value.length > 254) {
    const error = new Error('INVALID_EMAIL');
    error.code = 'INVALID_EMAIL';
    throw error;
  }

  return value;
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

function requireDatabase() {
  if (!isDatabaseConfigured()) {
    const error = new Error('DATABASE_NOT_CONFIGURED');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
}

export async function createUser({ email, password }) {
  requireDatabase();

  const normalizedEmail = normalizeEmail(email);
  const plainPassword = String(password || '');

  if (plainPassword.length < 12 || plainPassword.length > 128) {
    const error = new Error('INVALID_PASSWORD');
    error.code = 'INVALID_PASSWORD';
    throw error;
  }

  const existing = await query(
    'SELECT id FROM users WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (existing.rows.length > 0) {
    const error = new Error('EMAIL_ALREADY_REGISTERED');
    error.code = 'EMAIL_ALREADY_REGISTERED';
    throw error;
  }

  const userId = crypto.randomUUID();

  const passwordHash = await argon2.hash(plainPassword, {
    type: argon2.argon2id
  });

  await query(
    `INSERT INTO users
      (id, email, password_hash)
     VALUES ($1, $2, $3)`,
    [userId, normalizedEmail, passwordHash]
  );

  return {
    id: userId,
    email: normalizedEmail
  };
}

export async function authenticateUser({ email, password }) {
  requireDatabase();

  const normalizedEmail = normalizeEmail(email);
  const plainPassword = String(password || '');

  const result = await query(
    `SELECT id, email, password_hash
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [normalizedEmail]
  );

  if (result.rows.length === 0) {
    const error = new Error('INVALID_CREDENTIALS');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const user = result.rows[0];

  const valid = await argon2.verify(
    user.password_hash,
    plainPassword
  );

  if (!valid) {
    const error = new Error('INVALID_CREDENTIALS');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  return {
    id: user.id,
    email: user.email
  };
}

export async function createSession(userId) {
  requireDatabase();

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const sessionId = crypto.randomUUID();

  const expiresAt = new Date(
    Date.now() + SESSION_TTL_MS
  );

  await query(
    `INSERT INTO sessions
      (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [
      sessionId,
      userId,
      tokenHash,
      expiresAt
    ]
  );

  return {
    sessionId,
    token,
    expiresAt
  };
}

export async function getSession(token) {
  requireDatabase();

  const value = String(token || '').trim();

  if (!value) {
    return null;
  }

  const tokenHash = hashSessionToken(value);

  const result = await query(
    `SELECT
       s.id AS session_id,
       s.user_id,
       s.expires_at,
       u.email
     FROM sessions s
     INNER JOIN users u
       ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

export async function revokeSession(token) {
  requireDatabase();

  const value = String(token || '').trim();

  if (!value) {
    return;
  }

  const tokenHash = hashSessionToken(value);

  await query(
    `UPDATE sessions
     SET revoked_at = NOW()
     WHERE token_hash = $1
       AND revoked_at IS NULL`,
    [tokenHash]
  );
}
