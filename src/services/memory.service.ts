import { db } from '../db.js';
import { createEmbedding } from '../embeddings.js';
import { vectorLiteral } from '../utils.js';
import { resolveProject } from './project.service.js';

export async function remember(input: {
  project?: string;
  actor?: string;
  repositoryId?: string;
  taskId?: string;
  agentKey?: string;
  type: string;
  title?: string;
  content: string;
  importance?: number;
  tags?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const project = await resolveProject(input.project, input.actor);
  const embedding = await createEmbedding(`${input.title ?? ''}\n${input.content}`);
  const result = await db.query(
    `INSERT INTO memories
      (project_id, repository_id, task_id, agent_key, memory_type, title, content, importance, tags, source, metadata, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
     RETURNING id, project_id, memory_type, title, content, importance, tags, source, created_at`,
    [
      project.id,
      input.repositoryId ?? null,
      input.taskId ?? null,
      input.agentKey ?? input.actor ?? null,
      input.type,
      input.title ?? null,
      input.content,
      Math.max(1, Math.min(10, input.importance ?? 5)),
      input.tags ?? [],
      input.source ?? 'agent',
      input.metadata ?? {},
      embedding ? vectorLiteral(embedding) : null,
    ],
  );
  return result.rows[0];
}

export async function recall(input: {
  project?: string;
  actor?: string;
  query: string;
  limit?: number;
  scope?: 'project' | 'global';
}) {
  const limit = Math.max(1, Math.min(30, input.limit ?? 8));
  const embedding = await createEmbedding(input.query);

  if (input.scope === 'global') {
    if (embedding) {
      const result = await db.query(
        `SELECT m.id, p.slug AS project, m.memory_type, m.title, m.content, m.importance, m.tags,
                1 - (m.embedding <=> $1::vector) AS similarity, m.created_at
         FROM memories m
         JOIN projects p ON p.id = m.project_id
         WHERE m.embedding IS NOT NULL
         ORDER BY m.embedding <=> $1::vector, m.importance DESC
         LIMIT $2`,
        [vectorLiteral(embedding), limit],
      );
      return result.rows;
    }
    const result = await db.query(
      `SELECT m.id, p.slug AS project, m.memory_type, m.title, m.content, m.importance, m.tags, m.created_at,
              ts_rank_cd(to_tsvector('simple', coalesce(m.title,'') || ' ' || m.content), websearch_to_tsquery('simple', $1)) AS rank
       FROM memories m JOIN projects p ON p.id = m.project_id
       WHERE to_tsvector('simple', coalesce(m.title,'') || ' ' || m.content) @@ websearch_to_tsquery('simple', $1)
       ORDER BY rank DESC, m.importance DESC, m.created_at DESC
       LIMIT $2`,
      [input.query, limit],
    );
    return result.rows;
  }

  const project = await resolveProject(input.project, input.actor);
  if (embedding) {
    const result = await db.query(
      `SELECT id, memory_type, title, content, importance, tags,
              1 - (embedding <=> $1::vector) AS similarity, created_at
       FROM memories
       WHERE project_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector, importance DESC
       LIMIT $3`,
      [vectorLiteral(embedding), project.id, limit],
    );
    return result.rows;
  }

  const result = await db.query(
    `SELECT id, memory_type, title, content, importance, tags, created_at,
            ts_rank_cd(to_tsvector('simple', coalesce(title,'') || ' ' || content), websearch_to_tsquery('simple', $1)) AS rank
     FROM memories
     WHERE project_id = $2
       AND to_tsvector('simple', coalesce(title,'') || ' ' || content) @@ websearch_to_tsquery('simple', $1)
     ORDER BY rank DESC, importance DESC, created_at DESC
     LIMIT $3`,
    [input.query, project.id, limit],
  );
  return result.rows;
}
