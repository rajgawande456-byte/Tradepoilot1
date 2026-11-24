const KNOWN_AUTH_ERRORS = Object.freeze({
  DATABASE_NOT_CONFIGURED: [503, 'DATABASE_NOT_CONFIGURED'],
  DATABASE_UNAVAILABLE: [503, 'DATABASE_UNAVAILABLE'],
  INVALID_EMAIL: [400, 'INVALID_EMAIL'],
  INVALID_PASSWORD: [400, 'INVALID_PASSWORD'],
  EMAIL_ALREADY_REGISTERED: [409, 'EMAIL_ALREADY_REGISTERED'],
  INVALID_CREDENTIALS: [401, 'INVALID_CREDENTIALS'],
  UNSUPPORTED_CONTENT_TYPE: [415, 'UNSUPPORTED_CONTENT_TYPE'],
  REQUEST_BODY_TOO_LARGE: [413, 'REQUEST_BODY_TOO_LARGE'],
  EMPTY_REQUEST_BODY: [400, 'EMPTY_REQUEST_BODY'],
  INVALID_JSON: [400, 'INVALID_JSON']
});

const DATABASE_CONNECTION_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53400',
  '28000',
  '28P01',
  '3D000'
]);

function hasDatabaseConnectionError(error, visited = new Set()) {
  if (!error || typeof error !== 'object' || visited.has(error)) {
    return false;
  }

  visited.add(error);
  const code = String(error.code || '').toUpperCase();

  if (DATABASE_CONNECTION_CODES.has(code) || code.startsWith('08')) {
    return true;
  }

  if (hasDatabaseConnectionError(error.cause, visited)) {
    return true;
  }

  return Array.isArray(error.errors) &&
    error.errors.some(item => hasDatabaseConnectionError(item, visited));
}

export function mapAuthError(error) {
  const code = String(error?.code || '').toUpperCase();
  const known = KNOWN_AUTH_ERRORS[code];

  if (known) {
    return { status: known[0], code: known[1] };
  }

  if (hasDatabaseConnectionError(error)) {
    return { status: 503, code: 'DATABASE_UNAVAILABLE' };
  }

  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    return {
      status: error.status,
      code: error.code || 'REQUEST_FAILED'
    };
  }

  return { status: 500, code: 'AUTH_REQUEST_FAILED' };
}
