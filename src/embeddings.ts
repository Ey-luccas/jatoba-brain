import { config } from './config.js';

export async function createEmbedding(text: string): Promise<number[] | null> {
  if (!config.embeddings.enabled) return null;
  if (!config.embeddings.apiUrl) return null;

  try {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.embeddings.apiKey) headers.authorization = `Bearer ${config.embeddings.apiKey}`;

  const response = await fetch(config.embeddings.apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.embeddings.model, input: text }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding?.length || embedding.length > 16000 || !embedding.every(Number.isFinite) || embedding.every(v => v === 0)) return null;
  return embedding;
  } catch {
    return null;
  }
}
