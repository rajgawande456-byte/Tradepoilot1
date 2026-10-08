import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  isDatabaseConfigured
} from './client.mjs';

const { Pool } = pg;

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const MIGRATIONS_DIR =
  path.join(__dirname, 'migrations');

const connectionString =
  String(
    process.env.DATABASE_URL || ''
  ).trim();

async function getMigrationFiles() {
  const files =
    await fs.readdir(
      MIGRATIONS_DIR
    );

  return files
    .filter(
      (file) =>
        file.endsWith('.sql')
    )
    .sort();
}

async function ensureMigrationsTable(
  client
) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function migrate() {
  if (
    !connectionString ||
    !isDatabaseConfigured()
  ) {
    throw new Error(
      'DATABASE_NOT_CONFIGURED'
    );
  }

  const pool =
    new Pool({
      connectionString,

      max: 1,

      connectionTimeoutMillis:
        Number(
          process.env.DB_CONNECTION_TIMEOUT_MS ||
          5000
        ),

      ssl:
        process.env.NODE_ENV ===
        'production'
          ? {
              rejectUnauthorized:
                true
            }
          : undefined
    });

  const client =
    await pool.connect();

  try {
    await ensureMigrationsTable(
      client
    );

    const files =
      await getMigrationFiles();

    for (const file of files) {
      const version =
        file.replace(
          /\.sql$/,
          ''
        );

      const existing =
        await client.query(
          `
            SELECT version
            FROM schema_migrations
            WHERE version = $1
            LIMIT 1
          `,
          [version]
        );

      if (
        existing.rows.length > 0
      ) {
        console.log(
          `Skipping migration: ${version}`
        );

        continue;
      }

      const migrationPath =
        path.join(
          MIGRATIONS_DIR,
          file
        );

      const sql =
        await fs.readFile(
          migrationPath,
          'utf8'
        );

      if (!sql.trim()) {
        throw new Error(
          `EMPTY_MIGRATION: ${file}`
        );
      }

      console.log(
        `Applying migration: ${version}`
      );

      await client.query(
        'BEGIN'
      );

      try {
        await client.query(
          sql
        );

        await client.query(
          `
            INSERT INTO schema_migrations
              (version)
            VALUES ($1)
          `,
          [version]
        );

        await client.query(
          'COMMIT'
        );

        console.log(
          `Applied migration: ${version}`
        );
      } catch (error) {
        await client.query(
          'ROLLBACK'
        );

        throw error;
      }
    }

    console.log(
      'Database migrations complete.'
    );
  } finally {
    client.release();

    await pool.end();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(
    'Database migration failed:',
    error.message
  );

  process.exitCode = 1;
}
