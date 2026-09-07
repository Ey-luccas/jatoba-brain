import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

export async function migrate() {
  const client = await db.connect();
  const root = fileURLToPath(new URL('../db/', import.meta.url));
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741838)');
    if (!(await client.query("SELECT to_regclass('public.projects') AS name")).rows[0].name) {
      await client.query(await readFile(path.join(root, 'init.sql'), 'utf8'));
    }
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(path.join(root, 'migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      const sql = await readFile(path.join(root, 'migrations', name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = (await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (previous && previous.checksum !== checksum) throw new Error(`Migration changed after application: ${name}`);
      if (previous) continue;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await migrate(); console.log('Migrations applied.'); }
  finally { await db.end(); }
}
