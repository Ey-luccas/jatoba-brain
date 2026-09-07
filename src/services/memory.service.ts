import { db } from '../db.js';
import { config } from '../config.js';
import { createEmbedding } from '../embeddings.js';
import { vectorLiteral } from '../utils.js';
import { resolveProject } from './project.service.js';
import { budget, resolveScope, type Scope } from './scope.js';
import { increment } from './runtime-metrics.js';

export const MEMORY_TYPES = ['GENERAL','TASK','DECISION','ERROR','SOLUTION','CHECKPOINT','ARCHITECTURE','DEPENDENCY','TODO','SESSION_SUMMARY'] as const;

export async function remember(input: Scope & {
  taskId?: string; sessionId?: string; agentKey?: string; type: string; title?: string;
  content: string; importance?: number; tags?: string[]; source?: string; metadata?: Record<string, unknown>;
}) {
  if (!input.content?.trim() || !input.type?.trim()) throw new Error('Memory type and content are required');
  const project = await resolveProject(input.project, input.actor);
  await resolveScope({ ...input, project: project.id, scope: 'project' });
  const embedding = await createEmbedding(`${input.title ?? ''}\n${input.content}`);
  if (!embedding) increment('embedding_fallback_total');
  const result = await db.query(
    `INSERT INTO memories
     (project_id,repository_id,task_id,session_id,agent_key,memory_type,title,content,importance,tags,source,metadata,embedding,
      embedding_provider,embedding_model,embedding_dimension,embedding_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14,$15,$16,$17)
     RETURNING id,project_id,repository_id,task_id,session_id,agent_key,memory_type,title,content,importance,tags,source,metadata,created_at`,
    [project.id, input.repositoryId ?? null, input.taskId ?? null, input.sessionId ?? null,
      input.agentKey ?? input.actor ?? null, input.type.toUpperCase(), input.title ?? null, input.content,
      budget(input.importance,5,10), input.tags ?? [], input.source ?? 'agent', input.metadata ?? {},
      embedding ? vectorLiteral(embedding) : null,
      embedding ? config.embeddings.provider : null,
      embedding ? config.embeddings.model : null,
      embedding?.length ?? null,
      embedding ? config.embeddings.version : null],
  );
  return result.rows[0];
}

export async function recall(input: Scope & { query: string; limit?: number; max_items?: number; type?: string }) {
  if (!input.query?.trim()) throw new Error('Query is required');
  const scope = await resolveScope(input);
  const limit = Math.min(budget(input.limit,8,30), budget(input.max_items,30,30));
  const embedding = await createEmbedding(input.query);
  if (embedding) increment('vector_retrieval_total');
  else increment('embedding_fallback_total');
  const result = await db.query(
    `WITH candidates AS (
      SELECT m.id,m.project_id,m.repository_id,m.task_id,m.session_id,m.memory_type,m.title,m.content,
        m.importance,m.tags,m.source,m.created_at,p.workspace_id,p.slug AS project,
        to_tsvector('simple',coalesce(m.title,'') || ' ' || m.content) @@ websearch_to_tsquery('simple',$1) AS text_match,
        ts_rank_cd(to_tsvector('simple',coalesce(m.title,'') || ' ' || m.content),websearch_to_tsquery('simple',$1)) AS rank,
        CASE WHEN $4::vector IS NOT NULL AND vector_dims(m.embedding)=vector_dims($4::vector)
          THEN greatest(0,1-(m.embedding <=> $4::vector)) ELSE 0 END AS similarity,
        1.0/(1.0+greatest(0,extract(epoch FROM (now()-m.created_at)))/2592000) AS recency
      FROM memories m JOIN projects p ON p.id=m.project_id
      WHERE ($2::uuid IS NULL OR m.project_id=$2) AND ($3::uuid IS NULL OR m.repository_id=$3)
        AND ($6::text IS NULL OR m.memory_type=$6)
    )
    SELECT *, 0.40*similarity + 0.35*(rank/(1+rank)) + 0.15*(importance/10.0) + 0.10*recency AS score
    FROM candidates WHERE text_match OR similarity>0.25
    ORDER BY score DESC,created_at DESC,id LIMIT $5`,
    [input.query,scope.projectId,scope.repositoryId,embedding ? vectorLiteral(embedding) : null,limit,input.type?.toUpperCase() ?? null],
  );
  return result.rows;
}
