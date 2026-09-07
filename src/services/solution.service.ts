import { db } from '../db.js';
import { resolveProject } from './project.service.js';
import type { Scope } from './scope.js';

export async function recordSolution(input: Scope & {
  errorId: string; solution: string; result?: string; taskId?: string; sessionId?: string;
  agentKey?: string; files?: string[];
}) {
  const project = await resolveProject(input.project,input.actor);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const error = (await client.query('SELECT * FROM errors WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [input.errorId,project.id])).rows[0];
    if (!error) throw new Error('Error not found in project');
    const row = (await client.query(
      `INSERT INTO solutions(project_id,repository_id,task_id,session_id,error_id,agent_key,solution,result,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [project.id,input.repositoryId ?? error.repository_id,input.taskId ?? error.task_id,input.sessionId ?? null,
        error.id,input.agentKey ?? input.actor ?? null,input.solution,input.result ?? null,{files:input.files ?? []}])).rows[0];
    await client.query("UPDATE errors SET solution=$2,status='resolved',updated_at=now() WHERE id=$1",[error.id,input.solution]);
    await client.query('COMMIT');
    return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
