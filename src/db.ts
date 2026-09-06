import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function pingDb(): Promise<boolean> {
  const result = await db.query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}
