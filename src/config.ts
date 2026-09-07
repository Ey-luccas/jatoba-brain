import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3338),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  trustProxyHops: Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? 0)),
  http: {
    bodyLimit: process.env.HTTP_BODY_LIMIT ?? '2mb',
    requestTimeoutMs: Number(process.env.HTTP_REQUEST_TIMEOUT_MS ?? 30000),
    headersTimeoutMs: Number(process.env.HTTP_HEADERS_TIMEOUT_MS ?? 10000),
    keepAliveTimeoutMs: Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? 5000),
  },
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  hstsEnabled: (process.env.HSTS_ENABLED ?? 'false').toLowerCase() === 'true',
  rateLimit: {
    enabled: (process.env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() === 'true',
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    healthMax: Number(process.env.RATE_LIMIT_HEALTH_MAX ?? 300),
    mcpMax: Number(process.env.RATE_LIMIT_MCP_MAX ?? 60),
  },
  apiKey: required('BRAIN_API_KEY'),
  allowedHosts: (process.env.ALLOWED_HOSTS ?? '127.0.0.1,localhost')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  databaseUrl: required('DATABASE_URL'),
  defaultWorkspace: process.env.DEFAULT_WORKSPACE ?? 'principal',
  exportDir: process.env.EXPORT_DIR ?? './exports',
  workspaceDir: process.env.WORKSPACE_DIR ?? './workspace',
  graphDir: process.env.GRAPH_DIR ?? './graphs',
  graphifyBin: process.env.GRAPHIFY_BIN ?? 'graphify',
  databaseStartup: {
    maxAttempts: Number(process.env.DB_STARTUP_MAX_ATTEMPTS ?? 10),
    backoffMs: Number(process.env.DB_STARTUP_BACKOFF_MS ?? 500),
    maxBackoffMs: Number(process.env.DB_STARTUP_MAX_BACKOFF_MS ?? 5000),
  },
  embeddings: {
    enabled: (process.env.EMBEDDINGS_ENABLED ?? 'false').toLowerCase() === 'true',
    provider: process.env.EMBEDDING_PROVIDER ?? process.env.EMBEDDINGS_PROVIDER ?? 'openai-compatible',
    apiUrl: process.env.EMBEDDING_BASE_URL ?? process.env.EMBEDDINGS_API_URL ?? '',
    apiKey: process.env.EMBEDDINGS_API_KEY ?? '',
    model: process.env.EMBEDDING_MODEL ?? process.env.EMBEDDINGS_MODEL ?? 'nomic-embed-text',
    dimension: Number(process.env.EMBEDDING_DIMENSION ?? process.env.EMBEDDINGS_DIMENSION ?? 0),
    timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? process.env.EMBEDDINGS_TIMEOUT_MS ?? 5000),
    version: process.env.EMBEDDING_VERSION ?? process.env.EMBEDDINGS_VERSION ?? '1',
  },
};
