import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';

await migrate();
const {app,close}=createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`Jatobá Brain listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  await close();
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
