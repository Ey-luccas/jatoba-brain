import { db } from '../db.js';
import { budget, resolveScope, type Scope } from './scope.js';
export type Entity = {type:string;id:string};
export type RelationsInput = Scope & {source?:Entity;relation?:string;limit?:number;depth?:number};

export async function relationsQuery(input: RelationsInput) {
  const s=await resolveScope(input);
  if(input.source && !(await db.query(`SELECT 1 FROM work_entities WHERE entity_type=$1 AND entity_id=$2
    AND ($3::uuid IS NULL OR project_id=$3) LIMIT 1`,[input.source.type,input.source.id,s.projectId])).rowCount) throw new Error('Entity not found in scope');
  return (await db.query(`SELECT e.*,p.workspace_id FROM memory_edges e JOIN projects p ON p.id=e.project_id
    WHERE ($1::uuid IS NULL OR e.project_id=$1) AND ($2::uuid IS NULL OR e.repository_id=$2)
      AND ($3::text IS NULL OR (e.source_type=$3 AND e.source_id=$4) OR (e.target_type=$3 AND e.target_id=$4))
      AND ($5::text IS NULL OR e.relation_type=$5) ORDER BY e.created_at,e.id LIMIT $6`,
    [s.projectId,s.repositoryId,input.source?.type??null,input.source?.id??null,input.relation??null,budget(input.limit,30,100)])).rows;
}

export async function traceRelationships(input: RelationsInput & {source:Entity}) {
  const depth=budget(input.depth,2,4), limit=budget(input.limit,40,100);
  let frontier=[input.source]; const visited=new Set<string>(); const edges=new Map<string,any>();
  for(let d=0;d<depth && frontier.length && edges.size<limit;d++) {
    const next:Entity[]=[];
    for(const node of frontier) {
      const key=node.type+':'+node.id;
      if(visited.has(key)) continue;
      visited.add(key);
      for(const edge of await relationsQuery({...input,source:node,limit:limit-edges.size || 1})) {
        if(edges.size>=limit) break;
        edges.set(edge.id,edge);
        for(const item of [{type:edge.source_type,id:edge.source_id},{type:edge.target_type,id:edge.target_id}])
          if(!visited.has(item.type+':'+item.id)) next.push(item);
      }
    }
    frontier=next.slice(0,limit);
  }
  return {source:input.source,depth,edges:[...edges.values()],visited:visited.size,limited:edges.size>=limit};
}

export async function timeline(input: Scope & {taskId?:string;limit?:number;before?:string}) {
  const s=await resolveScope(input);
  if(input.taskId && !(await db.query('SELECT 1 FROM tasks WHERE id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::uuid IS NULL OR repository_id=$3)',
    [input.taskId,s.projectId,s.repositoryId])).rowCount) throw new Error('Task not found in scope');
  return (await db.query(`SELECT * FROM (
    SELECT * FROM work_events WHERE ($1::uuid IS NULL OR project_id=$1)
      AND ($2::uuid IS NULL OR repository_id=$2) AND ($3::uuid IS NULL OR task_id=$3)
      AND ($5::bigint IS NULL OR id<$5) ORDER BY created_at DESC,id DESC LIMIT $4
    ) recent ORDER BY created_at,id`,[s.projectId,s.repositoryId,input.taskId??null,budget(input.limit,30,100),input.before??null])).rows;
}
