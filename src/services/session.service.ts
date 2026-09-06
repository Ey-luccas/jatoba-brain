import { db } from '../db.js';
import { resolveProject } from './project.service.js';

export async function startSession(input: {
  project?: string;
  actor?: string;
  agentKey?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}) {
  const project = await resolveProject(input.project, input.actor);
  const result = await db.query(
    `INSERT INTO sessions (project_id, agent_key, title, metadata)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [project.id, input.agentKey ?? input.actor ?? null, input.title ?? null, input.metadata ?? {}],
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
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE sessions SET summary=$2, finished_at=NOW() WHERE id=$1 RETURNING *`,
      [input.sessionId, input.summary],
    );
    const session = result.rows[0];
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);

    if (input.promoteToMemory ?? true) {
      await client.query(
        `INSERT INTO memories
          (project_id, agent_key, memory_type, title, content, importance, tags, source, metadata)
         VALUES ($1,$2,'SESSION_SUMMARY',$3,$4,$5,$6,'session_summary',$7)`,
        [
          session.project_id,
          session.agent_key,
          session.title ?? `Session ${session.id}`,
          input.summary,
          Math.max(1, Math.min(10, input.importance ?? 6)),
          input.tags ?? ['session'],
          { session_id: session.id },
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
