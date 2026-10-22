import crypto from 'node:crypto';

const FYERS_BASE_URL = 'https://api-t1.fyers.in/api/v3';

export class FyersError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'FyersError';
    this.code = code;
    this.status = status;
  }
}

export function getFyersConfig(env = process.env) {
  const appId = String(env.FYERS_APP_ID || '').trim();
  const secret = String(env.FYERS_SECRET_KEY || '').trim();
  const redirectUri = String(env.FYERS_REDIRECT_URI || '').trim();

  if (!appId || !secret || !redirectUri) {
    throw new FyersError(
      'FYERS_NOT_CONFIGURED',
      'FYERS credentials and redirect URL must be configured.'
    );
  }

  return { appId, secret, redirectUri };
}

export function createFyersLoginUrl(env = process.env) {
  const { appId, redirectUri } = getFyersConfig(env);
  const state = crypto.randomBytes(32).toString('hex');

  const url = new URL(`${FYERS_BASE_URL}/generate-authcode`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);

  return { url: url.toString(), state };
}

export async function exchangeFyersAuthCode(authCode, env = process.env) {
  const { appId, secret, redirectUri } = getFyersConfig(env);

  if (!authCode || typeof authCode !== 'string') {
    throw new FyersError('FYERS_AUTH_CODE_MISSING', 'Authorization code is required.', 400);
  }

  const response = await fetch(`${FYERS_BASE_URL}/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      appId,
      secret_key: secret,
      code: authCode
    }),
    signal: AbortSignal.timeout(15000)
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    throw new FyersError