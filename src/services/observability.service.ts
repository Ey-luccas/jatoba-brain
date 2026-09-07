import { performance } from 'node:perf_hooks';
import { db, pingDb } from '../db.js';
import { config } from '../config.js';
import { resolveProject } from './project.service.js';
import { graphifyAvailable } from './graph.service.js';
import { resolveScope, type Scope } from './scope.js';
import { increment, observeDuration, prometheusText, runtimeSnapshot } from './runtime-metrics.js';

export { increment, observeDuration, prometheusText, runtimeSnapshot };

const graphTools=['graph_index','graph_query','graph_neighbors','graph_impact'];

export async function observe<T>(tool:string,input:Record<string,unknown>,fn:()=>Promise<T>):Promise<T> {
  const start=performance.now(); let status='success',items=0;
  increment('mcp_calls_total');
  increment(`mcp_calls_${tool}`);
  try {
    const result=await fn();
    items=Array.isArray(result)?result.length:
      typeof result==='object' && result!==null && 'items_returned' in result ? Number(result.items_returned)||0 : 0;
    if(tool==='recall') increment('recall_calls_total');
    if(tool==='context_retrieve') { increment('context_retrievals_total'); increment('context_items_returned_total',items); }
    if(graphTools.includes(tool)) increment(tool==='graph_index'?'graph_index_success_total':'graph_query_success_total');
    return result;
  } catch(error) {
    status='error';
    increment('mcp_errors_total');
    if(tool==='recall') increment('recall_errors_total');
    if(tool==='context_retrieve') increment('context_retrieval_errors_total');
    if(graphTools.includes(tool)) increment(tool==='graph_index'?'graph_index_errors_total':'graph_query_errors_total');
    throw error;
  } finally {
    const duration=performance.now()-start;
    observeDuration('mcp_duration_ms',duration);
    if(tool==='recall') observeDuration('recall_duration_ms',duration);
    if(tool==='context_retrieve') observeDuration('context_duration_ms',duration);
    if(graphTools.includes(tool)) observeDuration(tool==='graph_index'?'graph_index_duration_ms':'graph_query_duration_ms',duration);
    try {
      let projectId=null;
      if(typeof input.project==='string') projectId=(await resolveProject(input.project)).id;
      const repositoryId=typeof input.repositoryId==='string' && projectId &&
        (await db.query('SELECT id FROM repositories WHERE id=$1 AND project_id=$2',[input.repositoryId,projectId])).rows[0]?.id || null;
      const candidate=input.agentKey??input.actor;
      const agent=typeof candidate==='string' ? (await db.query('SELECT key FROM agents WHERE key=$1',[candidate])).rows[0]?.key??null : null;
      await db.query(`INSERT INTO audit_log(agent,project_id,repository_id,tool,operation,status,duration_ms,items_returned)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7)`,[agent,projectId,repositoryId,tool,status,duration,items]);
    } catch { console.error('Audit write failed'); }
  }
}

export async function health() {
  try {
    const database=await pingDb();
    const vector=Boolean((await db.query("SELECT 1 FROM pg_extension WHERE extname='vector'")).rowCount);
    const graphify=await graphifyAvailable();
    const status=!database?'UNHEALTHY':(!graphify || (config.embeddings.enabled && !config.embeddings.apiUrl)?'DEGRADED':'HEALTHY');
    return {ok:database,status,service:'jatoba-brain',app:true,database,pgvector:vector,graphify,
      memory:process.memoryUsage(),node_version:process.version,
      db_pool:{total:db.totalCount,idle:db.idleCount,waiting:db.waitingCount,active:Math.max(0,db.totalCount-db.idleCount)},
      uptime_seconds:Math.floor(process.uptime())};
  } catch { return {ok:false,status:'UNHEALTHY',service:'jatoba-brain',app:true,database:false,pgvector:false,uptime_seconds:Math.floor(process.uptime())}; }
}

export async function metrics(input:Scope) {
  const s=await resolveScope(input);
  const result:Record<string,number>={};
  for(const table of ['projects','repositories','sessions','tasks','memories','checkpoints','errors'] as const) {
    const column=table==='projects'?'id':'project_id';
    const filter=table==='projects'?'':table==='repositories'?' AND ($2::uuid IS NULL OR id=$2)':' AND ($2::uuid IS NULL OR repository_id=$2)';
    result[table+'_count']=Number((await db.query(`SELECT count(*) FROM ${table} WHERE ($1::uuid IS NULL OR ${column}=$1)${filter}`,table==='projects'?[s.projectId]:[s.projectId,s.repositoryId])).rows[0].count);
  }
  result.agents_count=Number((await db.query(`SELECT count(DISTINCT agent_key) FROM sessions WHERE ($1::uuid IS NULL OR project_id=$1)
    AND ($2::uuid IS NULL OR repository_id=$2)`,[s.projectId,s.repositoryId])).rows[0].count);
  const tasks=(await db.query(`SELECT status,count(*)::int AS count FROM tasks WHERE ($1::uuid IS NULL OR project_id=$1)
    AND ($2::uuid IS NULL OR repository_id=$2) GROUP BY status`,[s.projectId,s.repositoryId])).rows;
  result.tasks_completed=tasks.find(t=>t.status==='completed')?.count??0;
  result.tasks_failed=tasks.find(t=>t.status==='failed')?.count??0;
  result.tasks_started=result.tasks_count;
  result.agents_active=Number((await db.query(`SELECT count(DISTINCT agent_key) FROM sessions WHERE status='active'
    AND ($1::uuid IS NULL OR project_id=$1) AND ($2::uuid IS NULL OR repository_id=$2)`,[s.projectId,s.repositoryId])).rows[0].count);
  result.memories_created=result.memories_count;result.errors_recorded=result.errors_count;result.checkpoints=result.checkpoints_count;
  const operations=(await db.query(`SELECT tool,count(*)::int AS calls,avg(duration_ms) AS latency,sum(items_returned) AS items
    FROM audit_log WHERE ($1::uuid IS NULL OR project_id=$1) AND ($2::uuid IS NULL OR repository_id=$2) GROUP BY tool`,[s.projectId,s.repositoryId])).rows;
  result.recalls=operations.find(o=>o.tool==='recall')?.calls??0;
  result.average_recall_latency=Number(operations.find(o=>o.tool==='recall')?.latency??0);
  result.graph_queries=operations.filter(o=>['graph_query','graph_neighbors','graph_impact','relations_query','trace_relationships'].includes(o.tool)).reduce((n,o)=>n+o.calls,0);
  result.context_items_returned=operations.filter(o=>['recall','context_retrieve'].includes(o.tool)).reduce((n,o)=>n+Number(o.items),0);
  Object.assign(result,runtimeSnapshot(),{db_pool_total:db.totalCount,db_pool_idle:db.idleCount,db_pool_waiting:db.waitingCount,db_pool_active:Math.max(0,db.totalCount-db.idleCount),process_rss_bytes:process.memoryUsage().rss,process_heap_used_bytes:process.memoryUsage().heapUsed});
  return result;
}
