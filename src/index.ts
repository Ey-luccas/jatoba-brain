import express from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { config } from './config.js';
import { pingDb, db } from './db.js';
import { authGuard, hostGuard } from './middleware/auth.js';
import { buildMcpServer } from './mcp/server.js';
import { registerRoutes } from './routes.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(hostGuard);

app.get('/health', async (_req, res) => {
  try {
    const database = await pingDb();
    res.json({ ok: true, service: 'jatoba-brain', version: '0.1.0', database });
  } catch (error) {
    res.status(503).json({ ok: false, database: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.use('/api', authGuard);
registerRoutes(app);

const mcpHandler = createMcpHandler(buildMcpServer);
const mcpNodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', authGuard, (req, res) => {
  void mcpNodeHandler(req, res);
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Jatobá Brain listening on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  await mcpHandler.close();
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
