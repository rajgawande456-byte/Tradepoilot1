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
import { mapAuthError } from './errors.mjs';

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
    const mapped = mapAuthError(error);
    if (mapped.status >= 500) {
      // Log only a short error code/name; never serialize database connection details.
      const diagnosticCode = String(
        error?.code || error?.cause?.code || error?.name || 'UNKNOWN'
      ).slice(0, 80);
      console.error('Authentication request failed:', diagnosticCode);
    }
    return errorResponse(mapped.code, mapped.status);
  }
}
