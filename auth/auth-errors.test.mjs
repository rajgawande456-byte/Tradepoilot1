import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAuthError } from './errors.mjs';

test('maps common DNS and socket failures to a retryable database error', () => {
  for (const code of [
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
    'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'
  ]) {
    assert.deepEqual(mapAuthError({ code }), {
      status: 503,
      code: 'DATABASE_UNAVAILABLE'
    }, code);
  }
});

test('detects a database connection error nested in cause or AggregateError', () => {
  assert.deepEqual(mapAuthError({ cause: { code: '08006' } }), {
    status: 503,
    code: 'DATABASE_UNAVAILABLE'
  });

  const aggregate = new AggregateError([
    new Error('first attempt failed'),
    Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' })
  ]);
  assert.deepEqual(mapAuthError(aggregate), {
    status: 503,
    code: 'DATABASE_UNAVAILABLE'
  });
});

test('keeps known auth errors and their HTTP status codes', () => {
  assert.deepEqual(mapAuthError({ code: 'INVALID_CREDENTIALS' }), {
    status: 401,
    code: 'INVALID_CREDENTIALS'
  });
  assert.deepEqual(mapAuthError({ code: 'EMAIL_ALREADY_REGISTERED' }), {
    status: 409,
    code: 'EMAIL_ALREADY_REGISTERED'
  });
  assert.deepEqual(mapAuthError({ code: 'DATABASE_NOT_CONFIGURED' }), {
    status: 503,
    code: 'DATABASE_NOT_CONFIGURED'
  });
});

test('does not mislabel SQL/schema errors as network outages', () => {
  assert.deepEqual(mapAuthError({ code: '42P01' }), {
    status: 500,
    code: 'AUTH_REQUEST_FAILED'
  });
});

test('does not expose unknown server error codes to clients', () => {
  assert.deepEqual(mapAuthError({ code: 'INTERNAL_SQL_DETAIL' }), {
    status: 500,
    code: 'AUTH_REQUEST_FAILED'
  });
});
