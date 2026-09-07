import { db } from '../db.js';
import { recall } from './memory.service.js';
import { graphQuery } from './graph.service.js';
import { relationsQuery, traceRelationships, timeline } from './work-graph.service.js';
import { budget,resolveScope,type Scope } from './scope.js';

export const RANKING_WEIGHTS={relevance:0.65,importance:0.20,recency:0.15};
export type ContextInput=Scope & {
  query:string; max_items?:number; max_memories?:number;max_tasks?:number;max_decisions?:number;max_errors?:number;
  max_graph_nodes?:number;max_graph_depth?:number;include_semantic?:boolean;include_structural_graph?:boolean;
  include_work_graph?:boolean;include_timeline?:boolean;
};
type Candidate={kind:string;id:string;project_id:string;repository_id?:string;score:number;data:any;sources:string[]};

export class HybridContextRetriever {
  async retrieve(input:ContextInput) {
    if(!input.query?.trim()) throw new Error('Query is required');
    const scope=await resolveScope(input),max=budget(input.max_items,30,100);
    const candidates:Candidate[]=[];const warnings:string[]=[];
    const push=(kind:string,row:any,relevance:number,source?:string) => {
      const recency=1/(1+Math.max(0,Date.now()-new Date(row.created_at??0).getTime())/2_592_000_000);
      candidates.push({kind,id:String(row.id),project_id:row.project_id??scope.projectId,repository_id:row.repository_id,
        score:RANKING_WEIGHTS.relevance*relevance+RANKING_WEIGHTS.importance*((row.importance??5)/10)+RANKING_WEIGHTS.recency*recency,
        data:row,sources:[source??kind+':'+row.id]});
    };
    if(input.include_semantic!==false) for(const m of await recall({...input,limit:budget(input.max_memories,10,30),max_items:max})) {
      // Work-record projections share the canonical source with their relational row.
      const source=(await db.query('SELECT metadata FROM memories WHERE id=$1',[m.id])).rows[0].metadata;
      push(source.entity_type??'MEMORY',source.entity_id?{...m,id:source.entity_id}:m,Math.max(m.text_match?0.7:0,Number(m.score)), 'MEMORY:'+m.id);
    }
    for(const [kind,table,field,cap] of input.include_semantic===false?[]:[
      ['TASK','tasks','coalesce(summary,description,title)',input.max_tasks??5],
      ['DECISION','decisions','decision',input.max_decisions??5],
      ['ERROR','errors','error_text',input.max_errors??5],
    ] as const) {
      const rows=(await db.query(`SELECT *,ts_rank_cd(to_tsvector('simple',title || ' ' || ${field}),websearch_to_tsquery('simple',$3)) AS relevance
        FROM ${table} WHERE ($1::uuid IS NULL OR project_id=$1) AND ($2::uuid IS NULL OR repository_id=$2)
        AND to_tsvector('simple',title || ' ' || ${field}) @@ websearch_to_tsquery('simple',$3)
        ORDER BY relevance DESC,created_at DESC LIMIT $4`,[scope.projectId,scope.repositoryId,input.query,budget(cap,5,20)])).rows;
      rows.forEach(r=>push(kind,r,Math.max(0.7,Number(r.relevance))));
    }
    if(input.include_structural_graph!==false) {
      const repos=scope.repositoryId?[{id:scope.repositoryId,project_id:scope.projectId}]:(await db.query(
        'SELECT id,project_id FROM repositories WHERE ($1::uuid IS NULL OR project_id=$1) ORDER BY id LIMIT 5',[scope.projectId])).rows;
      for(const repo of repos) {
        const graph=await graphQuery({project:repo.project_id,repositoryId:repo.id,query:input.query,
          max_nodes:budget(input.max_graph_nodes,10,50),depth:budget(input.max_graph_depth,1,4),max_edges:20});
        if(graph.status!=='READY') warnings.push('STRUCTURAL_'+graph.status+':'+repo.id);
        for(const node of graph.nodes) push('FILE',{...node,project_id:repo.project_id,repository_id:repo.id},0.6,'FILE:'+repo.id+':'+(node.file??node.id));
        for(const edge of graph.edges) push('STRUCTURAL_RELATION',{...edge,id:[edge.source,edge.relation,edge.target].join(':'),
          project_id:repo.project_id,repository_id:repo.id},0.45,'GRAPH_EDGE:'+repo.id+':'+edge.source+':'+edge.target);
      }
    }
    if(input.include_work_graph!==false) {
      for(const seed of candidates.filter(c=>['TASK','DECISION','ERROR','CHECKPOINT','SOLUTION','FILE'].includes(c.kind)).slice(0,10)) {
        const source={type:seed.kind,id:seed.kind==='FILE'?seed.repository_id+':'+(seed.data.file??seed.id):seed.id};
        const exists=(await db.query('SELECT 1 FROM work_entities WHERE project_id=$1 AND entity_type=$2 AND entity_id=$3',
          [seed.project_id,source.type,source.id])).rowCount;
        if(!exists) continue;
        const {edges}=await traceRelationships({project:seed.project_id,repositoryId:scope.repositoryId??undefined,
          source,depth:budget(input.max_graph_depth,2,4),limit:10});
        for(const e of edges) push('RELATION',e,0.55,'EDGE:'+e.id);
        const tables:Record<string,string>={TASK:'tasks',DECISION:'decisions',ERROR:'errors',SOLUTION:'solutions',CHECKPOINT:'checkpoints'};
        for(const e of edges) for(const [kind,id] of [[e.source_type,e.source_id],[e.target_type,e.target_id]]) {
          if(!tables[kind]) continue;
          const row=(await db.query(`SELECT * FROM ${tables[kind]} WHERE id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR repository_id=$3)`,
            [id,seed.project_id,scope.repositoryId])).rows[0];
          if(row) push(kind,row,0.6);
        }
      }
    }
    if(input.include_timeline!==false) {
      for(const row of await timeline({...input,limit:5})) push('EVENT',row,0.25,'EVENT:'+row.id);
      const checkpoint=(await db.query(`SELECT * FROM checkpoints WHERE ($1::uuid IS NULL OR project_id=$1)
        AND ($2::uuid IS NULL OR repository_id=$2) ORDER BY created_at DESC LIMIT 1`,[scope.projectId,scope.repositoryId])).rows[0];
      if(checkpoint) push('CHECKPOINT',checkpoint,0.5);
    }
    const unique=new Map<string,Candidate>();
    for(const item of candidates) {
      const key=[item.project_id,item.repository_id??'',item.kind,item.id].join(':');
      const old=unique.get(key);
      if(old) {old.sources=[...new Set([...old.sources,...item.sources,item.kind+':'+item.id])];old.score=Math.max(old.score,item.score);}
      else unique.set(key,item);
    }
    const limits:Record<string,number>={MEMORY:budget(input.max_memories,10,30),TASK:budget(input.max_tasks,5,20),
      DECISION:budget(input.max_decisions,5,20),ERROR:budget(input.max_errors,5,20),FILE:budget(input.max_graph_nodes,10,50),
      RELATION:Math.max(1,Math.floor(max/3))};
    limits.STRUCTURAL_RELATION=Math.max(1,Math.floor(max/5));
    const selected:Candidate[]=[];
    for(const c of [...unique.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id))) {
      const allowed=limits[c.kind]??max;
      if(selected.filter(s=>s.kind===c.kind).length<allowed && selected.length<max) selected.push(c);
    }
    const select=(kinds:string[])=>selected.filter(c=>kinds.includes(c.kind)).map(c=>({...c.data,score:c.score,sources:c.sources}));
    return {summary:`${selected.length} context items selected`,items_returned:selected.length,warnings:[...new Set(warnings)],
      memories:select(['MEMORY','SOLUTION']),tasks:select(['TASK']),decisions:select(['DECISION']),errors:select(['ERROR']),
      structural_context:select(['FILE','STRUCTURAL_RELATION']),work_graph:select(['RELATION']),timeline:select(['EVENT','CHECKPOINT']),
      sources:[...new Map(selected.flatMap(c=>c.sources.map(ref=>[c.project_id+':'+ref,
        {ref,project_id:c.project_id,repository_id:c.repository_id}] as const))).values()]};
  }
}
export const contextRetrieve=(input:ContextInput)=>new HybridContextRetriever().retrieve(input);
