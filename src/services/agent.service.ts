import { db } from '../db.js';
import { resolveScope, type Scope } from './scope.js';
import { projectContext } from './project.service.js';
import { relationsQuery } from './work-graph.service.js';

export async function registerAgent(input: {key:string;name:string;role:string;provider?:string;model?:string;capabilities?:string[];metadata?:Record<string,unknown>}) {
  return (await db.query(`INSERT INTO agents(key,name,role,provider,model,capabilities,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role,
      provider=EXCLUDED.provider,model=EXCLUDED.model,capabilities=EXCLUDED.capabilities,metadata=EXCLUDED.metadata RETURNING *`,
    [input.key,input.name,input.role,input.provider??null,input.model??null,input.capabilities??[],input.metadata??{}])).rows[0];
}

export async function taskAssign(input: Scope & {taskId:string;agentKey:string;force_takeover?:boolean;sessionId?:string}) {
  const scope=await resolveScope(input);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const task=(await client.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR repository_id=$3) FOR UPDATE',
      [input.taskId,scope.projectId,scope.repositoryId])).rows[0];
    if(!task) throw new Error('Task not found in scope');
    if(['completed','cancelled'].includes(task.status)) throw new Error('Task is already finished');
    if(task.status==='running' && task.agent_key!==input.agentKey && !input.force_takeover) {
      await client.query('ROLLBACK');
      return {claimed:false,assigned_agent:task.agent_key,task_id:task.id,reason:'TASK_ALREADY_OWNED'};
    }
    if(task.agent_key!==input.agentKey) {
      await client.query("SELECT add_work_edge($1,$2,'AGENT',$3,'HANDED_OFF_TO','AGENT',$4,$5)",
        [task.project_id,task.repository_id,task.agent_key,input.agentKey,{task_id:task.id,session_id:input.sessionId??null}]);
    }
    const updated=(await client.query(`UPDATE tasks SET agent_key=$2,status='running',started_at=now(),
      session_id=COALESCE($3,session_id),finished_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[task.id,input.agentKey,input.sessionId??null])).rows[0];
    await client.query("SELECT add_work_edge($1,$2,'TASK',$3,'ASSIGNED_TO','AGENT',$4)",[task.project_id,task.repository_id,task.id,input.agentKey]);
    await client.query('COMMIT');
    return {claimed:true,task:updated};
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}

export async function agentHandoff(input: Scope & {from_agent?:string;to_agent?:string;taskId?:string}) {
  const scope=await resolveScope(input);
  if(!scope.projectId) throw new Error('Handoff requires a project');
  const ctx=await projectContext(scope.projectId,{repositoryId:scope.repositoryId??undefined,max_items:80});
  if(input.taskId && !(await db.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR repository_id=$3)',
    [input.taskId,scope.projectId,scope.repositoryId])).rowCount) throw new Error('Task not found in scope');
  const params=[scope.projectId,scope.repositoryId,input.from_agent??null,input.taskId??null];
  const filter='project_id=$1 AND ($2::uuid IS NULL OR repository_id=$2) AND ($3::text IS NULL OR agent_key=$3)';
  const tasks=(await db.query(`SELECT * FROM tasks WHERE ${filter} AND ($4::uuid IS NULL OR id=$4) ORDER BY updated_at DESC LIMIT 20`,params)).rows;
  const decisions=(await db.query(`SELECT * FROM decisions WHERE ${filter} AND ($4::uuid IS NULL OR task_id=$4) ORDER BY created_at DESC LIMIT 10`,params)).rows;
  const errors=(await db.query(`SELECT * FROM errors WHERE ${filter} AND ($4::uuid IS NULL OR task_id=$4) ORDER BY created_at DESC LIMIT 10`,params)).rows;
  const solutions=(await db.query(`SELECT * FROM solutions WHERE ${filter} AND ($4::uuid IS NULL OR task_id=$4) ORDER BY created_at DESC LIMIT 10`,params)).rows;
  const changes=(await db.query(`SELECT * FROM changes WHERE ${filter} AND ($4::uuid IS NULL OR task_id=$4) ORDER BY created_at DESC LIMIT 10`,params)).rows;
  const sessions=(await db.query(`SELECT id,summary,metadata FROM sessions WHERE ${filter} ORDER BY started_at DESC LIMIT 5`,params.slice(0,3))).rows;
  const checkpoints=(await db.query(`SELECT * FROM checkpoints WHERE ${filter} AND ($4::uuid IS NULL OR task_id=$4) ORDER BY created_at DESC LIMIT 1`,params)).rows;
  if(input.from_agent && input.to_agent) await db.query("SELECT add_work_edge($1,$2,'AGENT',$3,'HANDED_OFF_TO','AGENT',$4,$5)",
    [scope.projectId,scope.repositoryId,input.from_agent,input.to_agent,{task_id:input.taskId??null}]);
  return {current_state:ctx.project,last_checkpoint:checkpoints[0]??null,
    active_tasks:tasks.filter(t=>['pending','running','blocked'].includes(t.status)),
    recent_completed_tasks:tasks.filter(t=>t.status==='completed'),important_decisions:decisions,
    known_errors:errors,solutions,sessions,
    pending_items:[...tasks.flatMap(t=>t.metadata.pending??[]),...sessions.flatMap(s=>s.metadata.pending??[])].slice(0,30),
    relevant_files:changes.flatMap(c=>c.changed_files).slice(0,30),
    recent_commits:changes.filter(c=>c.commit_hash).map(c=>({commit:c.commit_hash,source:c.metadata.source??'agent',task_id:c.task_id})),
    relevant_graph:await relationsQuery({...input,scope:'project',source:input.taskId?{type:'TASK',id:input.taskId}:undefined,limit:30})};
}
