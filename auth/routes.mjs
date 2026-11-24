import {
  createUser,
  authenticateUser,
  createSession,
  getSession,
  revokeSession
} from './service.mjs';

import {
  readJsonBody,
  getSessionToken,
  createSessionCookie,
  clearSessionCookie
} from './http.mjs';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function errorResponse(code, status = 400, headers = {}) {
  return { status, body: { error: code }, headers };
}

export async function handleAuthRequest(req) {
  const path = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;

  try {
    if (path === '/api/v1/auth/signup' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const user = await createUser({ email: body.email, password: body.password });
      const session = await createSession(user.id);
      return {
        status: 201,
        body: { data: { user } },
        headers: { 'set-cookie': createSessionCookie(session.token, SESSION_TTL_SECONDS) }
      };
    }

    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const user = await authenticateUser({ email: body.email, password: body.password });
      const session = await createSession(user.id);
      return {
        status: 200,
        body: { data: { user } },
        headers: { 'set-cookie': createSessionCookie(session.token, SESSION_TTL_SECONDS) }
      };
    }

    if (path === '/api/v1/auth/logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) await revokeSession(token);
      return {
        status: 200,
        body: { data: { loggedOut: true } },
        headers: { 'set-cookie': clearSessionCookie() }
      };
    }

    if (path === '/api/v1/me' && req.method === 'GET') {
      const token = getSessionToken(req);
      if (!token) return errorResponse('AUTH_REQUIRED', 401);
      const session = await getSession(token);
      if (!session) {
        return errorResponse('AUTH_REQUIRED', 401, { 'set-cookie': clearSessionCookie() });
      }
      return {
        status: 200,
        body: {
          data: {
            user: { id: session.user_id, email: session.email },
            session: { expiresAt: session.expires_at }
          }
        }
      };
    }
    return null;
  } catch (error) {
    const known = {
      DATABASE_NOT_CONFIGURED: [503, 'DATABASE_NOT_CONFIGURED'],
      INVALID_EMAIL: [400, 'INVALID_EMAIL'],
      INVALID_PASSWORD: [400, 'INVALID_PASSWORD'],
      EMAIL_ALREADY_REGISTERED: [409, 'EMAIL_ALREADY_REGISTERED'],
      INVALID_CREDENTIALS: [401, 'INVALID_CREDENTIALS'],
      UNSUPPORTED_CONTENT_TYPE: [415, 'UNSUPPORTED_CONTENT_TYPE'],
      REQUEST_BODY_TOO_LARGE: [413, 'REQUEST_BODY_TOO_LARGE'],
      EMPTY_REQUEST_BODY: [400, 'EMPTY_REQUEST_BODY'],
      INVALID_JSON: [400, 'INVALID_JSON']
    };
    const mapped = known[error?.code];
    if (mapped) return errorResponse(mapped[1], mapped[0]);
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
      return errorResponse(error.code || 'REQUEST_FAILED', error.status);
    }
    console.error('Authentication request failed:', error);
    return errorResponse('AUTH_REQUEST_FAILED', 500);
  }
}
