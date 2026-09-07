import { createHash } from 'node:crypto';
import { config } from './config.js';
import { increment } from './services/runtime-metrics.js';

export interface EmbeddingProvider {
  providerName: string;
  modelName: string;
  dimension: number | null;
  embed(text: string): Promise<number[] | null>;
}

const cache = new Map<string, number[]>();

function validEmbedding(embedding: unknown): embedding is number[] {
  return Array.isArray(embedding) && embedding.length > 0 && embedding.length <= 16000
    && embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
    && embedding.some((value) => value !== 0);
}

export function createEmbeddingProvider(): EmbeddingProvider {
  return {
    providerName: config.embeddings.provider,
    modelName: config.embeddings.model,
    dimension: config.embeddings.dimension || null,
    async embed(text: string) {
      if (!config.embeddings.enabled || !config.embeddings.apiUrl) return null;
      const response = await fetch(config.embeddings.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.embeddings.apiKey ? { authorization: `Bearer ${config.embeddings.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.embeddings.model, input: text }),
        signal: AbortSignal.timeout(config.embeddings.timeoutMs),
      });
      if (!response.ok) { increment('embedding_provider_failures_total'); return null; }
      const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
      const embedding = payload.data?.[0]?.embedding;
      if (!validEmbedding(embedding)) { increment('embedding_dimension_errors_total'); return null; }
      if (config.embeddings.dimension && embedding.length !== config.embeddings.dimension) { increment('embedding_dimension_errors_total'); return null; }
      return embedding;
    },
  };
}

export async function createEmbedding(text: string): Promise<number[] | null> {
  const key = createHash('sha256').update(`${config.embeddings.provider}\0${config.embeddings.model}\0${text}`).digest('hex');
  const cached = cache.get(key);
  if (cached) return [...cached];
  try {
    const embedding = await createEmbeddingProvider().embed(text);
    if (embedding) cache.set(key, embedding);
    return embedding;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') increment('embedding_timeouts_total');
    else increment('embedding_provider_failures_total');
    return null;
  }
}
