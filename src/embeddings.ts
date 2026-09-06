import { config } from './config.js';

export async function createEmbedding(text: string): Promise<number[] | null> {
  if (!config.embeddings.enabled) return null;
  if (!config.embeddings.apiUrl) throw new Error('EMBEDDINGS_API_URL is required when embeddings are enabled');

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.embeddings.apiKey) headers.authorization = `Bearer ${config.embeddings.apiKey}`;

  const response = await fetch(config.embeddings.apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.embeddings.model, input: text }),
  });

  if (!response.ok) {
    throw new Error(`Embedding provider returned ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding?.length) throw new Error('Embedding provider returned no embedding');
  return embedding;
}
