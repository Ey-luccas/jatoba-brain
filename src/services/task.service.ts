import { db } from '../db.js';
import { resolveProject } from './project.service.js';

export async function startTask(input: {
  project?: string;
  actor?: string;
  repositoryId?: string;
  agentKey: string;
  title: string;
  description?: string;
  priority?: number;
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
}) {
  const project = await resolveProject(input.project, input.actor);
  const result = await db.query(
    `INSERT INTO tasks
      (project_id, repository_id, parent_task_id, agent_key, title, description, status, priority, started_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7,NOW(),$8)
     RETURNING *`,
    [
      project.id,
      input.repositoryId ?? null,
      input.parentTaskId ?? null,
      input.agentKey,
      input.title,
      input.description ?? null,
      Math.max(1, Math.min(10, input.priority ?? 5)),
      input.metadata ?? {},
    ],
  );
  return result.rows[0];
}

export async function finishTask(input: {
  taskId: string;
  status?: 'completed' | 'failed' | 'blocked' | 'cancelled';
  summary: string;
  filesChanged?: Array<{ path: string; action?: string }>;
  commitHash?: string;
  branch?: string;
  tests?: Record<string, unknown>;
  decisions?: string[];
  pending?: string[];
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const taskResult = await client.query(
      `UPDATE tasks
       SET status = $2, finished_at = NOW(), summary = $3,
           metadata = metadata || $4::jsonb, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [input.taskId, input.status ?? 'completed', input.summary, JSON.stringify(input.metadata ?? {})],
    );
    const task = taskResult.rows[0];
    if (!task) throw new Error(`Task not found: ${input.taskId}`);

    await client.query(
      `INSERT INTO task_runs
        (task_id, agent_key, status, finished_at, input_tokens, output_tokens, metadata)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6)`,
      [task.id, task.agent_key, input.status ?? 'completed', input.inputTokens ?? null, input.outputTokens ?? null, input.metadata ?? {}],
    );

    if (input.filesChanged?.length || input.commitHash || input.tests) {
      await client.query(
        `INSERT INTO changes
          (project_id, repository_id, task_id, agent_key, commit_hash, branch, summary, changed_files, tests)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          task.project_id,
          task.repository_id,
          task.id,
          task.agent_key,
          input.commitHash ?? null,
          input.branch ?? null,
          input.summary,
          JSON.stringify(input.filesChanged ?? []),
          input.tests ?? {},
        ],
      );
    }

    for (const decision of input.decisions ?? []) {
      await client.query(
        `INSERT INTO decisions (project_id, repository_id, task_id, agent_key, title, decision)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [task.project_id, task.repository_id, task.id, task.agent_key, decision.slice(0, 180), decision],
      );
    }

    if (input.pending?.length) {
      await client.query(
        `INSERT INTO memories (project_id, repository_id, task_id, agent_key, memory_type, title, content, importance, tags, source)
         VALUES ($1,$2,$3,$4,'TODO','Pendências após tarefa',$5,7,$6,'task_finish')`,
        [task.project_id, task.repository_id, task.id, task.agent_key, input.pending.join('\n- '), ['todo', 'pending']],
      );
    }

    await client.query('COMMIT');
    return task;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordDecision(input: {
  project?: string;
  actor?: string;
  repositoryId?: string;
  taskId?: string;
  agentKey?: string;
  title: string;
  decision: string;
  reason?: string;
  consequences?: string;
  status?: string;
}) {
  const project = await resolveProject(input.project, input.actor);
  const result = await db.query(
    `INSERT INTO decisions
      (project_id, repository_id, task_id, agent_key, title, decision, reason, consequences, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [project.id, input.repositoryId ?? null, input.taskId ?? null, input.agentKey ?? input.actor ?? null,
      input.title, input.decision, input.reason ?? null, input.consequences ?? null, input.status ?? 'accepted'],
  );
  return result.rows[0];
}

export async function recordError(input: {
  project?: string;
  actor?: string;
  repositoryId?: string;
  taskId?: string;
  agentKey?: string;
  title: string;
  error: string;
  cause?: string;
  solution?: string;
  status?: string;
}) {
  const project = await resolveProject(input.project, input.actor);
  const result = await db.query(
    `INSERT INTO errors
      (project_id, repository_id, task_id, agent_key, title, error_text, cause, solution, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [project.id, input.repositoryId ?? null, input.taskId ?? null, input.agentKey ?? input.actor ?? null,
      input.title, input.error, input.cause ?? null, input.solution ?? null, input.status ?? (input.solution ? 'resolved' : 'open')],
  );
  return result.rows[0];
}

export async function createCheckpoint(input: {
  project?: string;
  actor?: string;
  repositoryId?: string;
  taskId?: string;
  agentKey?: string;
  title: string;
  summary: string;
  commitHash?: string;
  branch?: string;
  tests?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  const project = await resolveProject(input.project, input.actor);
  const result = await db.query(
    `INSERT INTO checkpoints
      (project_id, repository_id, task_id, agent_key, title, summary, commit_hash, branch, tests, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [project.id, input.repositoryId ?? null, input.taskId ?? null, input.agentKey ?? input.actor ?? null,
      input.title, input.summary, input.commitHash ?? null, input.branch ?? null, input.tests ?? {}, input.metadata ?? {}],
  );
  return result.rows[0];
}
