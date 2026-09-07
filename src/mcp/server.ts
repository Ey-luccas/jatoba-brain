import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { asJsonText } from '../utils.js';
import { createProject,addRepository,listProjects,projectContext,selectProject } from '../services/project.service.js';
import { remember,recall } from '../services/memory.service.js';
import { startTask,finishTask,recordDecision,recordError,createCheckpoint,TASK_STATUSES } from '../services/task.service.js';
import { startSession,sessionNote,finishSession } from '../services/session.service.js';
import { recordSolution } from '../services/solution.service.js';
import { gitSnapshot } from '../services/git.service.js';
import { exportDocuments } from '../services/export.service.js';
import { graphIndex,graphStatus,graphQuery } from '../services/graph.service.js';
import { relationsQuery,traceRelationships,timeline } from '../services/work-graph.service.js';
import { contextRetrieve } from '../services/context.service.js';
import { registerAgent,taskAssign,agentHandoff } from '../services/agent.service.js';
import { observe,metrics } from '../services/observability.service.js';
import { db } from '../db.js';
import { resolveScope } from '../services/scope.js';

const text=z.string().min(1).max(32000), id=z.string().uuid(), optional=text.optional();
const metadata=z.record(z.string(),z.unknown()).optional();
const list=z.array(text).max(200).optional(), limit=z.number().int().min(1).max(100).optional();
const scope={project:optional,actor:optional,repositoryId:id.optional(),scope:z.enum(['project','repository','global']).optional()};
const record={project:optional,actor:optional,repositoryId:id.optional(),taskId:id.optional(),sessionId:id.optional(),agentKey:optional};
const graph={project:text,repositoryId:id,query:optional,entity:optional,depth:z.number().int().min(1).max(4).optional(),
  max_nodes:limit,max_edges:z.number().int().min(1).max(200).optional()};
const entity=z.object({type:z.enum(['AGENT','TASK','DECISION','ERROR','SOLUTION','CHECKPOINT','SESSION','FILE','COMMIT','CHANGE','MEMORY']),id:text});
const relations={...scope,source:entity.optional(),relation:optional,limit,depth:z.number().int().min(1).max(4).optional()};
type Tool={description:string;schema:z.ZodType;run:(input:any)=>Promise<unknown>};
export const toolRegistry:Record<string,Tool>={};
function tool<S extends z.ZodType>(name:string,description:string,schema:S,run:(input:z.infer<S>)=>Promise<unknown>) {
  toolRegistry[name]={description,schema,run};
}
tool('project_create','Cria ou atualiza projeto.',z.object({name:text,slug:optional,description:optional,workspace:optional}),createProject);
tool('project_list','Lista projetos.',z.object({}),listProjects);
tool('project_select','Seleciona projeto por actor.',z.object({actor:text,project:text}),i=>selectProject(i.actor,i.project));
tool('repository_add','Registra repositorio no projeto.',z.object({project:text,name:text,slug:optional,path:optional,remoteUrl:optional,defaultBranch:optional}),addRepository);
tool('repository_list','Lista repositorios do projeto.',z.object({project:text,limit}),async i=>{
  const s=await resolveScope(i);return (await db.query('SELECT * FROM repositories WHERE project_id=$1 ORDER BY created_at LIMIT $2',[s.projectId,i.limit??30])).rows;
});
tool('project_context','Contexto limitado de projeto/repositorio.',z.object({project:text,repositoryId:id.optional(),max_items:limit,max_tasks:limit,
  max_decisions:limit,max_errors:limit,include_structural:z.boolean().optional(),query:optional}),i=>projectContext(i.project,i));
tool('start_task','Inicia tarefa.',z.object({...record,agentKey:text,title:text,description:optional,priority:z.number().int().min(1).max(10).optional(),
  parentTaskId:id.optional(),metadata}),startTask);
tool('finish_task','Finaliza tarefa com arquivos, testes e pendencias.',z.object({taskId:id,project:optional,agentKey:optional,
  status:z.enum(TASK_STATUSES.filter(status=>status!=='pending'&&status!=='running') as ['blocked','completed','failed','cancelled']).optional(),summary:text,filesChanged:z.array(z.object({path:text,action:optional})).max(200).optional(),
  commitHash:optional,branch:optional,tests:metadata,decisions:list,pending:list,inputTokens:z.number().int().nonnegative().optional(),
  outputTokens:z.number().int().nonnegative().optional(),metadata}),finishTask);
tool('remember','Guarda memoria persistente.',z.object({...record,type:text,title:optional,content:text,
  importance:z.number().int().min(1).max(10).optional(),tags:list,source:optional,metadata}),remember);
tool('recall','Busca hibrida; projeto por padrao; fallback textual.',z.object({...scope,query:text,
  limit:z.number().int().min(1).max(30).optional(),max_items:limit,type:optional}),recall);
tool('record_decision','Registra decisao e contexto.',z.object({...record,title:text,decision:text,reason:optional,consequences:optional,status:optional,files:list}),recordDecision);
tool('record_error','Registra erro, causa e solucao opcional.',z.object({...record,title:text,error:text,cause:optional,solution:optional,status:optional,files:list}),recordError);
tool('record_solution','Liga uma solucao ao erro existente.',z.object({...record,errorId:id,solution:text,result:optional,files:list}),recordSolution);
tool('checkpoint','Registra estado estavel.',z.object({...record,title:text,summary:text,commitHash:optional,branch:optional,tests:metadata,metadata}),createCheckpoint);
tool('git_snapshot','Le Git; associa a tarefa somente quando informado.',z.object({...scope,repositoryPath:text,taskId:id.optional(),agentKey:optional}),
  i=>gitSnapshot(i.repositoryPath,i));
tool('session_start','Abre sessao de agente.',z.object({...scope,agentKey:optional,title:optional,metadata}),startSession);
tool('session_note','Nota bruta opcional; nao promovida automaticamente.',z.object({sessionId:id,role:z.enum(['user','assistant','system','tool','agent']),content:text,metadata}),sessionNote);
tool('session_finish','Finaliza sessao; promove resumo fornecido.',z.object({sessionId:id,summary:text,promoteToMemory:z.boolean().optional(),
  importance:z.number().int().min(1).max(10).optional(),tags:list,pending:list,checkpointId:id.optional()}),finishSession);
tool('export_docs','Exporta Markdown derivado do banco.',z.object({project:text}),async i=>{
  const result=await exportDocuments(i.project);return {directory:result.directory,files:result.files};
});
tool('graph_index','Extracao AST explicita por repositorio com Graphify.',z.object(graph),graphIndex);
tool('graph_status','Estado, commit e contagens do grafo.',z.object(graph),graphStatus);
tool('graph_query','Consulta estrutural limitada.',z.object(graph),graphQuery);
tool('graph_neighbors','Vizinhos de entidade com profundidade limitada.',z.object({...graph,entity:text}),graphQuery);
tool('graph_impact','Dependencias reversas potencialmente afetadas.',z.object({...graph,entity:text}),i=>graphQuery(i,true));
tool('relations_query','Consulta relacoes operacionais.',z.object(relations),relationsQuery);
tool('trace_relationships','Percorre relacoes sem repetir ciclos; ate 4 niveis.',z.object({...relations,source:entity}),traceRelationships);
tool('project_timeline','Eventos cronologicos recentes do projeto.',z.object({...scope,project:text,limit,before:optional}),timeline);
tool('repository_timeline','Eventos cronologicos recentes do repositorio.',z.object({...scope,project:text,repositoryId:id,limit,before:optional}),timeline);
tool('task_timeline','Eventos cronologicos da tarefa.',z.object({...scope,project:text,taskId:id,limit,before:optional}),timeline);
tool('context_retrieve','Combina memoria, estrutura e historico com fontes e limites.',z.object({...scope,query:text,
  max_items:limit,max_memories:limit,max_tasks:limit,max_decisions:limit,max_errors:limit,max_graph_nodes:limit,
  max_graph_depth:z.number().int().min(1).max(4).optional(),include_semantic:z.boolean().optional(),
  include_structural_graph:z.boolean().optional(),include_work_graph:z.boolean().optional(),include_timeline:z.boolean().optional()}),contextRetrieve);
tool('agent_register','Registra identidade independente do provedor.',z.object({key:text,name:text,role:text,provider:optional,model:optional,capabilities:list,metadata}),registerAgent);
tool('task_assign','Assume tarefa; informa conflito com outro agente.',z.object({...scope,project:text,taskId:id,agentKey:text,sessionId:id.optional(),force_takeover:z.boolean().optional()}),taskAssign);
tool('task_takeover','Transfere tarefa somente com force_takeover explicito.',z.object({...scope,project:text,taskId:id,agentKey:text,sessionId:id.optional(),force_takeover:z.literal(true)}),taskAssign);
tool('agent_handoff','Recupera trabalho anterior e registra transferencia explicita.',z.object({...scope,project:text,from_agent:optional,to_agent:optional,taskId:id.optional()}),agentHandoff);
tool('metrics','Metricas reais, sem estimar tokens economizados.',z.object(scope),metrics);

export async function runTool(name:string,input:unknown={}) {
  const definition=toolRegistry[name];
  if(!definition) throw new Error('Unknown tool');
  const parsed=definition.schema.parse(input??{});
  return observe(name,parsed as Record<string,unknown>,()=>definition.run(parsed));
}
export function buildMcpServer() {
  const server=new McpServer({name:'jatoba-brain',version:'0.1.0'},
    {instructions:'Selecione projeto por actor ou informe project. Global somente explicitamente. Recupere contexto limitado e registre fatos reutilizaveis.'});
  for(const [name,definition] of Object.entries(toolRegistry)) {
    server.registerTool(name,{description:definition.description,inputSchema:definition.schema as z.ZodObject},
      async input=>{
        try {const value=await runTool(name,input);return {content:[{type:'text' as const,text:asJsonText(value)}],structuredContent:{data:value}};}
        catch {return {isError:true,content:[{type:'text' as const,text:'Operation failed: check scope, identifiers, ownership and service availability.'}]};}
      });
  }
  return server;
}
