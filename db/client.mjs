
import pg from 'pg';

const { Pool } = pg;

const connectionString = String(
  process.env.DATABASE_URL || ''
).trim();

let pool = null;

function createPool() {
  if (!connectionString) {
    return null;
  }

  const isProduction =
    process.env.NODE_ENV === 'production';

  // SSL certificate verification is enabled by default.
  // Set DB_SSL_REJECT_UNAUTHORIZED=false only when
  // you have verified that your database requires it
  // and understand the associated security risk.
  const rejectUnauthorized =
    String(
      process.env.DB_SSL_REJECT_UNAUTHORIZED ?? 'true'
    ).toLowerCase() !== 'false';

  const ssl = isProduction
    ? { rejectUnauthorized }
    : undefined;

  return new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(
      process.env.DB_IDLE_TIMEOUT_MS || 30000
    ),
    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS || 5000
    ),
    ...(ssl ? { ssl } : {})
  });
}

pool = createPool();

export function isDatabaseConfigured() {
  return Boolean(pool);
}

export async function query(text, params = []) {
  if (!pool) {
    const error = new Error(
      'DATABASE_NOT_CONFIGURED'
    );
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }

  return pool.query(text, params);
}

export async function closeDatabase() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
}

export async function checkDatabaseConnection() {
  if (!pool) {
    const error = new Error(
      'DATABASE_NOT_CONFIGURED'
    );
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }

  const result = await pool.query(
    'SELECT 1 AS ok'
  );

  return result.rows[0]?.ok === 1;
}