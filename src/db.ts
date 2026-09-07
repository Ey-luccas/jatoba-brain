import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});
// Idle sockets may close during a database restart; subsequent queries reconnect.
db.on('error', () => console.error('Database connection interrupted'));

export async function pingDb(): Promise<boolean> {
  const result = await db.query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}
