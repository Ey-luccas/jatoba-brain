import { db } from '../db.js';
import { resolveProject } from './project.service.js';

export async function startSession(input: {
  project?: string;
  actor?: string;
  agentKey?: string;
  repositoryId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}) {
  const project = await resolveProject(input.project, input.actor);
  const agentKey=input.agentKey??input.actor;
  if(agentKey) await db.query("INSERT INTO agents(key,name,role) VALUES($1,$1,'agent') ON CONFLICT DO NOTHING",[agentKey]);
  const result = await db.query(
    `INSERT INTO sessions (project_id, agent_key, title, metadata,repository_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [project.id, input.agentKey ?? input.actor ?? null, input.title ?? null, input.metadata ?? {},input.repositoryId ?? null],
  );
  return result.rows[0];
}

export async function sessionNote(input: {
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'agent';
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const result = await db.query(
    `INSERT INTO session_messages (session_id, role, content, metadata)
     VALUES ($1,$2,$3,$4)
     RETURNING id, session_id, role, created_at`,
    [input.sessionId, input.role, input.content, input.metadata ?? {}],
  );
  return result.rows[0];
}

export async function finishSession(input: {
  sessionId: string;
  summary: string;
  promoteToMemory?: boolean;
  importance?: number;
  tags?: string[];
  pending?: string[];
  checkpointId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current=(await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE',[input.sessionId])).rows[0];
    if(!current) throw new Error('Session not found');
    if(current.finished_at) throw new Error('Session already finished');
    if(input.checkpointId && !(await client.query('SELECT 1 FROM checkpoints WHERE id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR repository_id=$3)',
      [input.checkpointId,current.project_id,current.repository_id])).rowCount) throw new Error('Checkpoint outside session scope');
    const result = await client.query(
      `UPDATE sessions SET summary=$2, finished_at=NOW(),status='completed',metadata=metadata||$3::jsonb WHERE id=$1 RETURNING *`,
      [input.sessionId, input.summary,JSON.stringify({pending:input.pending??[],checkpoint_id:input.checkpointId??null})],
    );
    const session = result.rows[0];
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);

    if (input.promoteToMemory ?? true) {
      await client.query(
        `INSERT INTO memories
          (project_id, agent_key, memory_type, title, content, importance, tags, source, metadata,repository_id,session_id)
         VALUES ($1,$2,'SESSION_SUMMARY',$3,$4,$5,$6,'session_summary',$7,$8,$9)`,
        [
          session.project_id,
          session.agent_key,
          session.title ?? `Session ${session.id}`,
          input.summary,
          Math.max(1, Math.min(10, input.importance ?? 6)),
          input.tags ?? ['session'],
          { session_id: session.id },
          session.repository_id,
          session.id,
        ],
      );
    }

    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
