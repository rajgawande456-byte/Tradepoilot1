import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query, closeDatabase } from './client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(
  __dirname,
  'migrations'
);

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getMigrationFiles() {
  const files = await fs.readdir(MIGRATIONS_DIR);

  return files
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function migrate() {
  await ensureMigrationsTable();

  const files = await getMigrationFiles();

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');

    const existing = await query(
      `
        SELECT version
        FROM schema_migrations
        WHERE version = $1
        LIMIT 1
      `,
      [version]
    );

    if (existing.rows.length > 0) {
      continue;
    }

    const migrationPath = path.join(
      MIGRATIONS_DIR,
      file
    );

    const sql = await fs.readFile(
      migrationPath,
      'utf8'
    );

    if (!sql.trim()) {
      throw new Error(
        `EMPTY_MIGRATION: ${file}`
      );
    }

    await query('BEGIN');

    try {
      await query(sql);

      await query(
        `
          INSERT INTO schema_migrations (version)
          VALUES ($1)
        `,
        [version]
      );

      await query('COMMIT');

      console.log(
        `Applied migration: ${version}`
      );
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  }

  console.log('Database migrations complete.');
}

try {
  await migrate();
} finally {
  await closeDatabase();
}
