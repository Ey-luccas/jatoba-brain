import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';
import { migrateWithRetry } from './migrate.js';

await migrateWithRetry();
const {app,close}=createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`Jatobá Brain listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
});
server.requestTimeout = Math.max(1000, config.http.requestTimeoutMs);
server.headersTimeout = Math.max(1000, config.http.headersTimeoutMs);
server.keepAliveTimeout = Math.max(1000, config.http.keepAliveTimeoutMs);

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  await close();
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
