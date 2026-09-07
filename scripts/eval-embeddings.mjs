import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

const corpus = JSON.parse(await readFile(new URL('../eval/semantic-corpus.json', import.meta.url), 'utf8'));
const url = process.env.EMBEDDING_BASE_URL ?? process.env.EMBEDDINGS_API_URL;
const model = process.env.EMBEDDING_MODEL ?? process.env.EMBEDDINGS_MODEL ?? 'nomic-embed-text';
const provider = process.env.EMBEDDING_PROVIDER ?? process.env.EMBEDDINGS_PROVIDER ?? 'openai-compatible';
const configuredDimension = Number(process.env.EMBEDDING_DIMENSION ?? process.env.EMBEDDINGS_DIMENSION ?? 0);
const timeoutMs = Number(process.env.EMBEDDING_TIMEOUT_MS ?? process.env.EMBEDDINGS_TIMEOUT_MS ?? 10000);
const runs = Math.max(3, Number(process.env.EMBEDDING_EVAL_RUNS ?? 3));

if ((process.env.EMBEDDINGS_ENABLED ?? 'false').toLowerCase() !== 'true' || !url) {
  console.error('Real embedding evaluation unavailable: set EMBEDDINGS_ENABLED=true and EMBEDDING_BASE_URL (or EMBEDDINGS_API_URL) to a local provider.');
  process.exit(2);
}

function tokens(text) { return new Set(text.toLocaleLowerCase('pt-BR').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9_]+/g) ?? []); }
function lexicalScore(query, text) {
  const q = tokens(query); const t = tokens(text);
  return q.size ? [...q].filter((item) => t.has(item)).length / q.size : 0;
}
function cosine(a, b) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}
function median(values) { return percentile(values, 0.5); }
function rank(items, score) { return [...items].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)); }
function metrics(results) {
  return [1, 3, 5].map((k) => Number((results.filter((item) => item.slice(0, k).some((id) => id === item.expected)).length / results.length).toFixed(3)));
}

async function embed(text) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.EMBEDDINGS_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDINGS_API_KEY}` } : {}) },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`embedding provider returned HTTP ${response.status}`);
  const data = (await response.json()).data?.[0]?.embedding;
  if (!Array.isArray(data) || !data.length || !data.every((value) => Number.isFinite(value)) || data.every((value) => value === 0)) throw new Error('embedding provider returned an invalid vector');
  if (configuredDimension && data.length !== configuredDimension) throw new Error(`embedding dimension ${data.length} differs from configured ${configuredDimension}`);
  return data;
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query('CREATE TEMP TABLE semantic_eval (id text PRIMARY KEY, content text NOT NULL)');
  for (const memory of corpus.memories) await client.query('INSERT INTO semantic_eval(id,content) VALUES($1,$2)', [memory.id, memory.text]);

  const allRuns = [];
  let dimension = configuredDimension || null;
  for (let run = 0; run < runs; run += 1) {
    const vectors = new Map();
    const embeddingLatencies = [];
    for (const item of [...corpus.memories, ...corpus.queries]) {
      const started = performance.now();
      const vector = await embed(item.text);
      embeddingLatencies.push(performance.now() - started);
      dimension ??= vector.length;
      vectors.set(item.id, vector);
    }
    const runResults = {text: [], vector: [], hybrid: []};
    for (const query of corpus.queries) {
      const textRows = (await client.query(`SELECT id,ts_rank_cd(to_tsvector('simple',content),websearch_to_tsquery('simple',$1)) AS rank FROM semantic_eval ORDER BY rank DESC,id`, [query.text])).rows;
      const textRanks = new Map(textRows.map((row) => [row.id, Number(row.rank)]));
      const queryVector = vectors.get(query.id);
      const vectorRanks = rank(corpus.memories, (memory) => cosine(queryVector, vectors.get(memory.id)));
      const hybridRanks = rank(corpus.memories, (memory) => 0.40 * cosine(queryVector, vectors.get(memory.id)) + 0.35 * (Number(textRanks.get(memory.id) ?? 0) / (1 + Number(textRanks.get(memory.id) ?? 0))) + 0.15 * 0.5 + 0.10);
      runResults.text.push({expected: query.expected, slice: textRows.map((row) => row.id)});
      runResults.vector.push({expected: query.expected, slice: vectorRanks.map((memory) => memory.id)});
      runResults.hybrid.push({expected: query.expected, slice: hybridRanks.map((memory) => memory.id)});
    }
    allRuns.push({results: runResults, embeddingLatencies});
  }

  const methods = ['text', 'vector', 'hybrid'];
  const summary = methods.map((method) => {
    const runsForMethod = allRuns.map((run) => metrics(run.results[method]));
    return {method, recall: [0, 1, 2].map((index) => Number((runsForMethod.reduce((sum, values) => sum + values[index], 0) / runsForMethod.length).toFixed(3)))};
  });
  const embeddingLatencies = allRuns.flatMap((run) => run.embeddingLatencies);
  const generated = new Date().toISOString();
  const lines = [
    '# Semantic Evaluation', '',
    '> Avaliação reproduzível do corpus público local. Estes números não são benchmark de produção.', '',
    `- Provider: \`${provider}\``, `- Modelo: \`${model}\``, `- Dimensão: \`${dimension}\``, `- Data: \`${generated}\``,
    `- Corpus: ${corpus.memories.length} memórias`, `- Queries: ${corpus.queries.length}`, `- Execuções: ${runs}`, '',
    '| Método | Recall@1 | Recall@3 | Recall@5 |', '| --- | ---: | ---: | ---: |',
    ...summary.map((item) => `| ${item.method} | ${item.recall[0]} | ${item.recall[1]} | ${item.recall[2]} |`), '',
    `Embedding latency: median ${median(embeddingLatencies).toFixed(2)} ms; p95 ${percentile(embeddingLatencies, 0.95).toFixed(2)} ms.`, '',
    '## Notes', '',
    '- GraphRAG não foi medido: este corpus não possui entidades estruturais ou Work Graph associadas.',
    '- O baseline usa PostgreSQL FTS (`to_tsvector`/`websearch_to_tsquery`).',
    '- O modo vector usa somente similaridade cosseno; hybrid reproduz os pesos atuais de `recall`.',
    '- O script não imprime, armazena ou inclui credenciais no relatório.', '',
  ];
  await writeFile(new URL('../docs/SEMANTIC_EVALUATION.md', import.meta.url), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
} finally {
  await client.end().catch(() => {});
}
