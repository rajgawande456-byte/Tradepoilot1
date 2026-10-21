
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

  // Render internal PostgreSQL connections can use
  // self-signed TLS certificates.
  // Keep TLS encryption enabled without disabling
  // certificate verification globally.
  const ssl = isProduction
    ? { rejectUnauthorized: false }
    : undefined;

  return new Pool({
    connectionString,
    ...(ssl ? { ssl } : {}),
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: Number(
      process.env.DB_IDLE_TIMEOUT_MS || 30000
    ),
    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS || 10000
    )
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

  return Number(result.rows[0]?.ok) === 1;
}
