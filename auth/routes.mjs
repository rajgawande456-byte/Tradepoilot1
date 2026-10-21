
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

function errorResponse(code, status = 400) {
  return {
    status,
    body: { error: code }
  };
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers
    }
  };
}

export async function handleAuthRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method.toUpperCase();

  try {
    if (method === 'POST' && path === '/api/auth/signup') {
      const body = await readJsonBody(req);
      const user = await createUser(body);
      const session = await createSession(user.id, SESSION_TTL_SECONDS);

      return jsonResponse(
        201,
        { user },
        { 'set-cookie': createSessionCookie(session.token, SESSION_TTL_SECONDS) }
      );
    }

    if (method === 'POST' && path === '/api/auth/login') {
      const body = await readJsonBody(req);
      const user = await authenticateUser(body);
      if (!user) return errorResponse('INVALID_CREDENTIALS', 401);

      const session = await createSession(user.id, SESSION_TTL_SECONDS);

      return jsonResponse(
        200,
        { user },
        { 'set-cookie': createSessionCookie(session.token, SESSION_TTL_SECONDS) }
      );
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      const token = getSessionToken(req);
      if (token) await revokeSession(token);

      return jsonResponse(
        200,
        { success: true },
        { 'set-cookie': clearSessionCookie() }
      );
    }

    if (method === 'GET' && path === '/api/auth/me') {
      const token = getSessionToken(req);
      if (!token) return errorResponse('UNAUTHENTICATED', 401);

      const session = await getSession(token);
      if (!session) {
        return jsonResponse(
          401,
          { error: 'UNAUTHENTICATED' },
          { 'set-cookie': clearSessionCookie() }
        );
      }

      return jsonResponse(200, { user: session.user });
    }

    return null;
  } catch (error) {
    if (error?.status && Number.isInteger(error.status)) {
      return errorResponse(error.code || 'REQUEST_FAILED', error.status);
    }

    return errorResponse('REQUEST_FAILED', 400);
  }
}
