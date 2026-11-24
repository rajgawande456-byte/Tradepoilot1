export async function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.status = 415;
    error.code = 'UNSUPPORTED_CONTENT_TYPE';
    throw error;
  }

  const chunks = [];
  let size = 0;
  const maxSize = 1024 * 1024;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) {
      const error = new Error('Request body too large');
      error.status = 413;
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    const error = new Error('Request body is required');
    error.status = 400;
    error.code = 'EMPTY_REQUEST_BODY';
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    return parsed;
  } catch {
    const error = new Error('Invalid JSON object');
    error.status = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
}

export function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(cookieHeader.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  const encodedToken = cookies.tradepilot_session;
  if (!encodedToken) return null;
  try {
    return decodeURIComponent(encodedToken);
  } catch {
    return null;
  }
}

export function createSessionCookie(token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `tradepilot_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}${secure}`
  ].join('; ');
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    'tradepilot_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0' + secure
  ].join('; ');
}
