import { db } from '../db.js';
import { resolveScope,budget,type Scope } from './scope.js';
import { projectContext,listProjects } from './project.service.js';
import { metrics } from './observability.service.js';
import { timeline,relationsQuery } from './work-graph.service.js';

const views=['repositories','sessions','tasks','memories','decisions','errors','checkpoints','audit_log'] as const;
export async function dashboardData(view:string,input:Scope & {query?:string;type?:string;limit?:number}) {
  if(view==='projects') return listProjects();
  const s=await resolveScope(input);
  if(view==='overview') {
    if(!s.projectId) throw new Error('Select a project');
    return {context:await projectContext(s.projectId,{repositoryId:s.repositoryId??undefined,max_items:80}),
      metrics:await metrics(input),last_activity:(await timeline({...input,limit:1}))[0]??null};
  }
  if(view==='metrics') return metrics(input);
  if(view==='timeline') return timeline({...input,limit:input.limit});
  if(view==='graph') return relationsQuery({...input,limit:input.limit??50});
  if(view==='agents') return (await db.query(`SELECT DISTINCT a.* FROM agents a JOIN sessions s ON s.agent_key=a.key
    WHERE ($1::uuid IS NULL OR s.project_id=$1) AND ($2::uuid IS NULL OR s.repository_id=$2) ORDER BY a.key LIMIT $3`,
    [s.projectId,s.repositoryId,budget(input.limit,30)])).rows;
  if(!views.includes(view as typeof views[number])) throw new Error('Unknown view');
  const column=view==='repositories'?'id':'repository_id';
  const fields=view==='memories'?'id,project_id,repository_id,memory_type,title,content,importance,created_at':'*';
  const search=view==='memories'?" AND ($3::text IS NULL OR memory_type=$3) AND ($4::text IS NULL OR to_tsvector('simple',coalesce(title,'')||' '||content) @@ websearch_to_tsquery('simple',$4))":'';
  const params:unknown[]=[s.projectId,s.repositoryId];
  if(view==='memories') params.push(input.type??null,input.query||null);
  params.push(budget(input.limit,30,100));
  return (await db.query(`SELECT ${fields} FROM ${view} WHERE ($1::uuid IS NULL OR project_id=$1)
    AND ($2::uuid IS NULL OR ${column}=$2)${search} ORDER BY ${view==='sessions'?'started_at':'created_at'} DESC LIMIT $${params.length}`,params)).rows;
}
