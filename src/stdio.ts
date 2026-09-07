import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcp/server.js';
import { db } from './db.js';
import { migrateWithRetry } from './migrate.js';

await migrateWithRetry();
console.error('Jatobá Brain MCP serving over stdio');
const transport=serveStdio(buildMcpServer);
let stopped=false;
async function shutdown() {
  if(stopped) return;
  stopped=true;
  await transport.close();
  await db.end();
}
process.stdin.once('end',()=>void shutdown());
process.once('SIGINT',()=>void shutdown());
process.once('SIGTERM',()=>void shutdown());
