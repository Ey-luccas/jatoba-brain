import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcp/server.js';
import { db } from './db.js';

console.error('Jatobá Brain MCP serving over stdio');
await serveStdio(buildMcpServer);
await db.end();
