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
    body: {
      error: code
    }
  };
}

export async function handleAuthRequest(req) {
  const path = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`
  ).pathname;

  try {
    if (path === '/api/v1/auth/signup' && req.method === 'POST') {
      const body = await readJsonBody(req);

      const user = await createUser({
        email: body.email,
        password: body.password
      });

      const session = await createSession(user.id);

      return {
        status: 201,
        body: {
          data: {
            user
          }
        },
        headers: {
          'set-cookie': createSessionCookie(
            session.token,
            SESSION_TTL_SECONDS
          )
        }
      };
    }

    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);

      const user = await authenticateUser({
        email: body.email,
        password: body.password
      });

      const session = await createSession(user.id);

      return {
        status: 200,
        body: {
          data: {
            user
          }
        },
        headers: {
          'set-cookie': createSessionCookie(
            session.token,
            SESSION_TTL_SECONDS
          )
        }
      };
    }

    if (path === '/api/v1/auth/logout' && req.method === 'POST') {
      const token = getSessionToken(req);

      if (token) {
        await revokeSession(token);
      }

      return {
        status: 200,
        body: {
          data: {
            loggedOut: true
          }
        },
        headers: {
          'set-cookie': clearSessionCookie()
        }
      };
    }

    if (path === '/api/v1/me' && req.method === 'GET') {
      const token = getSessionToken(req);

      if (!token) {
        return errorResponse('AUTH_REQUIRED', 401);
      }

      const session = await getSession(token);

      if (!session) {
        return errorResponse('AUTH_REQUIRED', 401);
      }

      return {
        status: 200,
        body: {
          data: {
            user: {
              id: session.user_id,
              email: session.email
            },
            session: {
              expiresAt: session.expires_at
            }
          }
        }
      };
    }

    return null;
  } catch (error) {
    if (error.code === 'DATABASE_NOT_CONFIGURED') {
      return errorResponse('DATABASE_NOT_CONFIGURED', 503);
    }

    if (error.code === 'INVALID_EMAIL') {
      return errorResponse('INVALID_EMAIL', 400);
    }

    if (error.code === 'INVALID_PASSWORD') {
      return errorResponse('INVALID_PASSWORD', 400);
    }

    if (error.code === 'EMAIL_ALREADY_REGISTERED') {
      return errorResponse('EMAIL_ALREADY_REGISTERED', 409);
    }

    if (error.code === 'INVALID_CREDENTIALS') {
      return errorResponse('INVALID_CREDENTIALS', 401);
    }

    if (error.code === 'UNSUPPORTED_CONTENT_TYPE') {
      return errorResponse('UNSUPPORTED_CONTENT_TYPE', 415);
    }

    if (error.code === 'REQUEST_BODY_TOO_LARGE') {
      return errorResponse('REQUEST_BODY_TOO_LARGE', 413);
    }

    if (error.code === 'EMPTY_REQUEST_BODY') {
      return errorResponse('EMPTY_REQUEST_BODY', 400);
    }

    if (error.code === 'INVALID_JSON') {
      return errorResponse('INVALID_JSON', 400);
    }

    return errorResponse('AUTH_REQUEST_FAILED', 500);
  }
}
