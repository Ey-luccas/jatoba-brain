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
  apiKey: required('BRAIN_API_KEY'),
  allowedHosts: (process.env.ALLOWED_HOSTS ?? '127.0.0.1,localhost')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  databaseUrl: required('DATABASE_URL'),
  defaultWorkspace: process.env.DEFAULT_WORKSPACE ?? 'principal',
  exportDir: process.env.EXPORT_DIR ?? './exports',
  workspaceDir: process.env.WORKSPACE_DIR ?? './workspace',
  embeddings: {
    enabled: (process.env.EMBEDDINGS_ENABLED ?? 'false').toLowerCase() === 'true',
    apiUrl: process.env.EMBEDDINGS_API_URL ?? '',
    apiKey: process.env.EMBEDDINGS_API_KEY ?? '',
    model: process.env.EMBEDDINGS_MODEL ?? 'nomic-embed-text',
  },
};
