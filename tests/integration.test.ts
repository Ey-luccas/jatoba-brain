import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { runTool,toolRegistry } from '../src/mcp/server.js';
import { TASK_STATUSES } from '../src/services/task.service.js';
import { createApp } from '../src/app.js';
import { graphIndex,graphQuery,graphStatus,traverseGraph } from '../src/services/graph.service.js';
import { createEmbedding } from '../src/embeddings.js';
import { health } from '../src/services/observability.service.js';
import { contextRetrieve } from '../src/services/context.service.js';
import { buildDocuments,exportDocuments } from '../src/services/export.service.js';
import { budget } from '../src/services/scope.js';
import { safeRepositoryPath } from '../src/services/paths.js';

let alpha:any,beta:any,backend:any,frontend:any,task:any,decision:any,error:any,solution:any,checkpoint:any,session:any;
let url:string,server:ReturnType<ReturnType<typeof createApp>['app']['listen']>,close:()=>Promise<void>;
const call=async(name:string,input:Record<string,unknown>={}):Promise<any>=>runTool(name,input);
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const request=(route:string,init:RequestInit={})=>fetch(url+route,{...init,headers:{authorization:'Bearer '+config.apiKey,...init.headers}});
const sql=(q:string,args:unknown[]=[])=>db.query(q,args);

before(async()=>{
  // Start from the original schema plus legacy data, then apply incremental migrations twice.
  await sql(await readFile('db/init.sql','utf8'));
  const legacy=(await sql("INSERT INTO projects(workspace_id,name,slug) SELECT id,'Legacy','legacy' FROM workspaces WHERE slug='principal' RETURNING id")).rows[0];
  await sql("INSERT INTO memories(project_id,memory_type,content) VALUES($1,'custom_legacy','preserved data')",[legacy.id]);
  await migrate();await migrate();
  assert.equal((await sql("SELECT content FROM memories WHERE project_id=$1",[legacy.id])).rows[0].content,'preserved data');
  alpha=await call('project_create',{name:'Alpha'});beta=await call('project_create',{name:'Beta'});
  backend=await call('repository_add',{project:alpha.id,name:'Backend',path:'backend'});
  frontend=await call('repository_add',{project:alpha.id,name:'Frontend',path:'frontend'});
  for(const name of ['backend','frontend']) {
    const root=path.join(config.workspaceDir,name);await mkdir(root,{recursive:true});
    await writeFile(path.join(root,'session.ts'),'export class Session { valid() { return true; } }\n');
    await writeFile(path.join(root,'auth.ts'),"import { Session } from './session';\nexport class AuthService { session = new Session(); authenticate() { return this.session.valid(); } }\n");
    git(root,'init');git(root,'add','.');git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  }
  await call('agent_register',{key:'codex-test',name:'Agent A',role:'backend',provider:'any',capabilities:['typescript']});
  await call('agent_register',{key:'claude-test',name:'Agent B',role:'reviewer',capabilities:['review']});
  const app=createApp();close=app.close;server=app.app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));url='http://127.0.0.1:'+(server.address() as any).port;
});
after(async()=>{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));await close();await db.end();});

test('incremental migrations are tracked; reapplication preserves data',async()=>{
  assert.equal((await sql('SELECT count(*) FROM schema_migrations')).rows[0].count,'4');
  assert.equal((await sql("SELECT count(*) FROM memories WHERE memory_type='custom_legacy'")).rows[0].count,'1');
});
test('project and repository isolation; explicit global; no implicit default project',async()=>{
  for(const [project,repo,content] of [[alpha,backend,'authentication backend Alpha'],[alpha,frontend,'authentication frontend Alpha'],[beta,null,'authentication Beta']]) {
    await call('remember',{project:project.id,repositoryId:repo?.id,type:'general',content});
  }
  assert.equal((await call('recall',{project:alpha.id,query:'authentication'})).length,2);
  const scoped=await call('recall',{project:alpha.id,repositoryId:frontend.id,scope:'repository',query:'authentication'});
  assert.equal(scoped.length,1);assert.match(scoped[0].content,/frontend/);
  assert.equal((await call('recall',{scope:'global',query:'authentication'})).length,3);
  await assert.rejects(call('recall',{query:'authentication'}));
  await assert.rejects(call('recall',{project:beta.id,repositoryId:frontend.id,query:'authentication'}));
  await assert.rejects(call('recall',{project:alpha.id,scope:'repository',query:'authentication'}));
});
test('structured references reject cross-project writes at database boundary',async()=>{
  await assert.rejects(call('remember',{project:beta.id,repositoryId:backend.id,type:'GENERAL',content:'forbidden'}));
  await assert.rejects(sql("INSERT INTO tasks(project_id,repository_id,agent_key,title) VALUES($1,$2,'bad','invalid')",[beta.id,backend.id]),/does not belong/);
});
test('budgets are bounded and validated',async()=>{
  assert.equal((await call('recall',{project:alpha.id,query:'authentication',max_items:1})).length,1);
  await assert.rejects(call('recall',{project:alpha.id,query:'authentication',limit:0}));
  assert.throws(()=>budget(NaN));assert.equal(budget(999),100);
  const ctx=await call('project_context',{project:alpha.id,max_items:1});
  assert.equal(Object.values(ctx).filter(Array.isArray).flat().length,1);
});
test('task status contract and registered agent identity are enforced',async()=>{
  for(const status of TASK_STATUSES) {
    const result=await sql(`INSERT INTO tasks(project_id,repository_id,agent_key,title,status)
      VALUES($1,$2,'codex-test',$3,$4) RETURNING status`,[alpha.id,backend.id,`status ${status}`,status]);
    assert.equal(result.rows[0].status,status);
  }
  await assert.rejects(sql(`INSERT INTO tasks(project_id,repository_id,agent_key,title,status)
    VALUES($1,$2,'codex-test','invalid status','unknown')`,[alpha.id,backend.id]));
  await assert.rejects(sql(`INSERT INTO tasks(project_id,repository_id,agent_key,title)
    VALUES($1,$2,'phantom-agent','invalid agent')`,[alpha.id,backend.id]),/Agent does not exist/);
  const auto=await call('start_task',{project:alpha.id,repositoryId:backend.id,agentKey:'auto-registered',title:'auto registration'});
  assert.equal((await sql('SELECT key FROM agents WHERE key=$1',['auto-registered'])).rows[0].key,'auto-registered');
  assert.equal(auto.agent_key,'auto-registered');
});
test('agent selection, task lifecycle, decisions, errors and solutions persist with automatic edges',async()=>{
  session=await call('session_start',{project:alpha.id,repositoryId:backend.id,agentKey:'codex-test',title:'Authentication'});
  await call('project_select',{project:alpha.id,actor:'codex-test'});
  task=await call('start_task',{actor:'codex-test',repositoryId:backend.id,sessionId:session.id,agentKey:'codex-test',title:'authentication refresh token'});
  decision=await call('record_decision',{project:alpha.id,taskId:task.id,sessionId:session.id,title:'authentication strategy',decision:'authentication tokens expire',files:['auth.ts'],agentKey:'codex-test'});
  error=await call('record_error',{project:alpha.id,taskId:task.id,sessionId:session.id,title:'authentication error',error:'authentication session expired',agentKey:'codex-test'});
  solution=await call('record_solution',{project:alpha.id,errorId:error.id,taskId:task.id,sessionId:session.id,solution:'authentication refresh retries',agentKey:'codex-test'});
  assert.equal(decision.repository_id,backend.id);
  assert.equal(solution.error_id,error.id);
  const edges=await call('relations_query',{project:alpha.id,source:{type:'TASK',id:task.id}});
  for(const relation of ['EXECUTED','CREATED','FOUND'])assert.ok(edges.some((e:any)=>e.relation_type===relation));
  const solutionEdges=await call('relations_query',{project:alpha.id,source:{type:'ERROR',id:error.id}});
  assert.ok(solutionEdges.some((e:any)=>e.relation_type==='RESOLVED_BY'&&e.target_id===solution.id));
  const decisionEdges=await call('relations_query',{project:alpha.id,source:{type:'DECISION',id:decision.id}});
  assert.ok(decisionEdges.some((e:any)=>e.relation_type==='AFFECTS'&&e.target_id.endsWith(':auth.ts')));
  const child=await call('start_task',{project:alpha.id,repositoryId:backend.id,agentKey:'codex-test',parentTaskId:task.id,title:'child task'});
  const childEdges=await call('relations_query',{project:alpha.id,source:{type:'TASK',id:child.id}});
  assert.ok(childEdges.some((e:any)=>e.relation_type==='DEPENDS_ON'&&e.target_id===task.id));
  await assert.rejects(call('record_decision',{project:beta.id,taskId:task.id,title:'bad',decision:'bad'}));
  await assert.rejects(call('record_error',{project:alpha.id,repositoryId:frontend.id,taskId:task.id,title:'bad',error:'bad'}));
});
test('Git captures created, modified and deleted files and does not invent a produced commit',async()=>{
  const root=path.join(config.workspaceDir,'backend');
  await writeFile(path.join(root,'auth.ts'),'export class AuthService { authenticate() { return true; } }\n');
  await writeFile(path.join(root,'new file.ts'),'export const version=1;\n');
  const snapshot=await call('git_snapshot',{project:alpha.id,taskId:task.id,repositoryPath:'backend'});
  assert.ok(snapshot.changed_files.some((f:any)=>f.path==='new file.ts'));
  assert.ok(snapshot.changed_files.some((f:any)=>f.path==='auth.ts'));
  const edges=await call('relations_query',{project:alpha.id,source:{type:'TASK',id:task.id}});
  assert.ok(edges.some((e:any)=>e.relation_type==='CHANGED'&&e.target_id.endsWith(':auth.ts')));
  assert.ok(!edges.some((e:any)=>e.relation_type==='PRODUCED'));
  await assert.rejects(call('git_snapshot',{project:alpha.id,taskId:task.id,repositoryPath:'frontend'}));
  git(root,'add','.');git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','authentication changes');
});
test('path validation rejects lexical escapes and symlinks',async()=>{
  await symlink('/etc',path.join(config.workspaceDir,'escape'));
  await assert.rejects(safeRepositoryPath('escape'),/escapes/);
  await assert.rejects(safeRepositoryPath('..'),/escapes/);
});
test('task ownership conflict, explicit takeover and concurrent assignment',async()=>{
  const denied=await call('task_assign',{project:alpha.id,taskId:task.id,agentKey:'claude-test'});
  assert.equal(denied.claimed,false);
  const takeover=await call('task_takeover',{project:alpha.id,taskId:task.id,agentKey:'claude-test',force_takeover:true});
  assert.equal(takeover.task.agent_key,'claude-test');
  await assert.rejects(call('finish_task',{taskId:task.id,agentKey:'codex-test',summary:'wrong owner'}));
  await call('task_takeover',{project:alpha.id,taskId:task.id,agentKey:'codex-test',force_takeover:true});
  const pending=await call('start_task',{project:alpha.id,repositoryId:frontend.id,agentKey:'unassigned',title:'claim race'});
  await sql("UPDATE tasks SET status='pending' WHERE id=$1",[pending.id]);
  const claims=await Promise.all(['codex-test','claude-test'].map(agentKey=>call('task_assign',{project:alpha.id,taskId:pending.id,agentKey})));
  assert.equal(claims.filter(r=>r.claimed).length,1);
  const assignment=await call('relations_query',{project:alpha.id,source:{type:'TASK',id:pending.id},relation:'ASSIGNED_TO'});
  assert.ok(assignment.length>0);
});
test('finish_task and checkpoint preserve files, pending items and supplied commit evidence',async()=>{
  const commit=git(path.join(config.workspaceDir,'backend'),'rev-parse','HEAD');
  await call('finish_task',{taskId:task.id,agentKey:'codex-test',summary:'authentication implemented',commitHash:commit,branch:'test',
    filesChanged:[{path:'auth.ts',action:'modified'}],tests:{unit:'passed'},pending:['Review expiry']});
  checkpoint=await call('checkpoint',{project:alpha.id,taskId:task.id,sessionId:session.id,agentKey:'codex-test',title:'authentication stable',summary:'authentication implemented',commitHash:commit});
  const edges=await call('relations_query',{project:alpha.id,source:{type:'TASK',id:task.id}});
  assert.ok(edges.some((e:any)=>e.relation_type==='PRODUCED'&&e.target_id===commit));
  assert.ok(edges.some((e:any)=>e.relation_type==='FINISHED_AT'&&e.target_id===checkpoint.id));
  await assert.rejects(call('finish_task',{taskId:task.id,summary:'duplicate'}),/already/);
  assert.ok((await call('recall',{project:alpha.id,query:'authentication'})).length);
});
test('timeline order, repository isolation and missing entities',async()=>{
  const events=await call('task_timeline',{project:alpha.id,taskId:task.id});
  assert.ok(events.length>=5);for(let i=1;i<events.length;i++)assert.ok(BigInt(events[i].id)>BigInt(events[i-1].id));
  const wrong=await call('repository_timeline',{project:alpha.id,repositoryId:frontend.id});
  assert.ok(wrong.every((e:any)=>e.task_id!==task.id));
  await assert.rejects(call('task_timeline',{project:beta.id,taskId:task.id}));
  await assert.rejects(call('relations_query',{project:beta.id,source:{type:'TASK',id:task.id}}));
  await assert.rejects(call('trace_relationships',{project:alpha.id,source:{type:'TASK',id:'missing'}}));
});
test('bounded work graph traversal handles cycles',async()=>{
  await sql("SELECT add_work_edge($1,$2,'DECISION',$3,'RELATED_TO','TASK',$4)",[alpha.id,backend.id,decision.id,task.id]);
  const shallow=await call('trace_relationships',{project:alpha.id,source:{type:'TASK',id:task.id},depth:1,limit:5});
  const deep=await call('trace_relationships',{project:alpha.id,source:{type:'TASK',id:task.id},depth:4,limit:20});
  assert.ok(shallow.edges.length<=5);assert.ok(deep.edges.length<=20);
  assert.equal(new Set(deep.edges.map((e:any)=>e.id)).size,deep.edges.length);
  await assert.rejects(call('trace_relationships',{project:alpha.id,source:{type:'TASK',id:task.id},depth:5}));
});
test('embedding failure and malformed responses fall back without losing writes',async()=>{
  const previous={...config.embeddings};
  config.embeddings.enabled=true;config.embeddings.apiUrl='http://127.0.0.1:1/unavailable';
  try {
    await call('remember',{project:alpha.id,repositoryId:backend.id,type:'GENERAL',content:'fallback resilience'});
    assert.ok((await call('recall',{project:alpha.id,query:'resilience'})).length);
    assert.equal(await createEmbedding('test'),null);
  } finally {Object.assign(config.embeddings,previous);}
});
test('pgvector semantic retrieval combines scores and supports mixed vector dimensions',async()=>{
  const provider=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const text=JSON.parse(body).input;res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:[{embedding:/unrelated/.test(text)?[0,1,0]:[1,0,0]}]}));
  });});
  await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
  const previous={...config.embeddings};config.embeddings.enabled=true;
  config.embeddings.apiUrl='http://127.0.0.1:'+(provider.address() as any).port;
  try {
    const memory=await call('remember',{project:alpha.id,repositoryId:backend.id,type:'GENERAL',content:'JWT refresh token rotation'});
    await call('remember',{project:beta.id,type:'GENERAL',content:'unrelated subject'});
    await sql("INSERT INTO memories(project_id,memory_type,content,embedding) VALUES($1,'GENERAL','other dimension','[1,0]'::vector)",[alpha.id]);
    const result=await call('recall',{project:alpha.id,query:'session renewal'});
    assert.ok(result.some((r:any)=>r.id===memory.id&&r.similarity>0.9));
    assert.ok(result.every((r:any)=>r.project_id===alpha.id));
  } finally {Object.assign(config.embeddings,previous);await new Promise<void>(r=>provider.close(()=>r()));}
});
test('importance and recency affect recall ordering',async()=>{
  const low=await call('remember',{project:alpha.id,type:'GENERAL',content:'ordering signal',importance:1});
  const high=await call('remember',{project:alpha.id,type:'GENERAL',content:'ordering signal',importance:10});
  await sql('UPDATE memories SET created_at=now()-interval \'60 days\' WHERE id=$1',[low.id]);
  const result=await call('recall',{project:alpha.id,query:'ordering signal',limit:2});
  assert.equal(result[0].id,high.id);
  assert.ok(result.findIndex((row:any)=>row.id===high.id)<result.findIndex((row:any)=>row.id===low.id));
});
test('real Graphify AST indexing, independent repository graphs and stale status',async()=>{
  const result=await graphIndex({project:alpha.id,repositoryId:frontend.id});
  assert.equal(result.status,'READY','Install graphifyy==0.9.55 and set GRAPHIFY_BIN to run structural integration tests');
  assert.ok(result.nodes_count>0);
  const neighbors=await graphQuery({project:alpha.id,repositoryId:frontend.id,entity:'Session',depth:2,max_nodes:10,max_edges:10});
  assert.ok(neighbors.nodes.length>0);assert.ok(neighbors.nodes.length<=10);assert.ok(neighbors.edges.length<=10);
  const missing=await graphStatus({project:alpha.id,repositoryId:backend.id});assert.equal(missing.status,'MISSING');
  const impact=await graphQuery({project:alpha.id,repositoryId:frontend.id,entity:'Session',depth:2},true);assert.ok(impact.nodes.length>0);
  await assert.rejects(graphQuery({project:beta.id,repositoryId:frontend.id,query:'Session'}));
  const root=path.join(config.workspaceDir,'frontend');await writeFile(path.join(root,'changed.ts'),'export const changed = true;\n');
  git(root,'add','.');git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','new revision');
  assert.equal((await graphStatus({project:alpha.id,repositoryId:frontend.id})).status,'STALE');
  assert.equal((await graphIndex({project:alpha.id,repositoryId:frontend.id})).status,'READY');
  assert.equal((await graphIndex({project:alpha.id,repositoryId:backend.id})).status,'READY');
  assert.notEqual((await sql('SELECT graph_path FROM repository_graphs WHERE repository_id=$1',[frontend.id])).rows[0].graph_path,
    (await sql('SELECT graph_path FROM repository_graphs WHERE repository_id=$1',[backend.id])).rows[0].graph_path);
  const neighborsViaMcp=await call('graph_neighbors',{project:alpha.id,repositoryId:frontend.id,entity:'Session',depth:1,max_nodes:10,max_edges:10});
  const impactViaMcp=await call('graph_impact',{project:alpha.id,repositoryId:frontend.id,entity:'Session',depth:1,max_nodes:10,max_edges:10});
  assert.ok(neighborsViaMcp.nodes.length>0&&impactViaMcp.nodes.length>0);
  const projectEvents=await call('project_timeline',{project:alpha.id,limit:5});
  assert.ok(projectEvents.length>0);
});
test('structural impact is reverse-only and traversal detects loops with hard budgets',()=>{
  const nodes=['A','B','C','D'].map(id=>({id,label:id,type:'class'}));
  const edges=[{source:'A',target:'B',relation:'CALLS'},{source:'B',target:'C',relation:'CALLS'},{source:'C',target:'B',relation:'CALLS'},{source:'D',target:'A',relation:'CALLS'}];
  const result=traverseGraph({nodes,edges},{entity:'B',depth:1,max_nodes:3,max_edges:2},true);
  assert.ok(result.nodes.some(n=>n.id==='A'));assert.ok(!result.nodes.some(n=>n.id==='D'));
  const limited=traverseGraph({nodes,edges},{entity:'B',depth:4,max_nodes:2,max_edges:1});
  assert.ok(limited.nodes.length<=2&&limited.edges.length<=1);
});
test('Graphify offline does not prevent memory or cached graph queries',async()=>{
  const bin=config.graphifyBin;config.graphifyBin='/missing/graphify';
  try {
    assert.equal((await graphIndex({project:alpha.id,repositoryId:backend.id})).status,'ERROR');
    assert.ok((await call('recall',{project:alpha.id,query:'authentication'})).length);
    assert.ok((await graphQuery({project:alpha.id,repositoryId:frontend.id,query:'Session'})).nodes.length);
  } finally {config.graphifyBin=bin;}
});
test('hybrid context, deduplication, traceability and total budget',async()=>{
  const result=await call('context_retrieve',{project:alpha.id,repositoryId:backend.id,query:'authentication',max_items:15});
  assert.ok(result.tasks.length+result.decisions.length+result.errors.length>0);
  assert.ok(result.timeline.length>0);assert.ok(result.work_graph.length>0);
  assert.ok(result.sources.every((s:any)=>s.project_id===alpha.id));
  const count=result.memories.length+result.tasks.length+result.decisions.length+result.errors.length+result.structural_context.length+result.work_graph.length+result.timeline.length;
  assert.equal(count,result.items_returned);assert.ok(count<=15);
  assert.equal(new Set(result.decisions.map((r:any)=>r.id)).size,result.decisions.length);
  const tiny=await contextRetrieve({project:alpha.id,query:'authentication',max_items:1});assert.equal(tiny.items_returned,1);
  const isolated=await contextRetrieve({project:beta.id,query:'authentication',max_items:20});
  assert.ok(isolated.sources.every(s=>s.project_id===beta.id));
  const unindexed=await call('repository_add',{project:alpha.id,name:'Unindexed'});
  const missing=await contextRetrieve({project:alpha.id,repositoryId:unindexed.id,query:'authentication',max_items:10});
  assert.ok(missing.warnings.some((warning:string)=>warning.startsWith('STRUCTURAL_MISSING')));
});
test('cross-agent handoff promotes summary, excludes raw chat and carries context',async()=>{
  await call('session_note',{sessionId:session.id,role:'user',content:'RAW_CONVERSATION_MARKER'});
  await call('session_finish',{sessionId:session.id,summary:'authentication handoff',pending:['Review expiry'],checkpointId:checkpoint.id});
  const other=await call('session_start',{project:alpha.id,repositoryId:backend.id,agentKey:'claude-test'});
  const handoff=await call('agent_handoff',{project:alpha.id,repositoryId:backend.id,from_agent:'codex-test',to_agent:'claude-test',taskId:task.id});
  assert.equal(handoff.last_checkpoint.id,checkpoint.id);
  assert.ok(handoff.important_decisions.some((d:any)=>d.id===decision.id));
  assert.ok(handoff.solutions.some((s:any)=>s.id===solution.id));
  assert.ok(handoff.relevant_files.some((f:any)=>f.path==='auth.ts'));
  assert.ok(handoff.pending_items.includes('Review expiry'));
  assert.ok(!JSON.stringify(handoff).includes('RAW_CONVERSATION_MARKER'));
  assert.equal((await sql("SELECT count(*) FROM memories WHERE content LIKE '%RAW_CONVERSATION_MARKER%'")).rows[0].count,'0');
  assert.equal(other.repository_id,backend.id);
  const wrong=await call('agent_handoff',{project:alpha.id,repositoryId:frontend.id});
  assert.ok(!JSON.stringify(wrong).includes(checkpoint.id));
});
test('REST, MCP and dashboard authentication; API path scope cannot be overwritten',async()=>{
  for(const endpoint of ['/api/projects','/mcp','/dashboard/','/api/dashboard/projects']) {
    assert.equal((await fetch(url+endpoint)).status,401);
  }
  assert.equal((await request('/dashboard/')).status,200);
  assert.equal((await request('/api/dashboard/projects')).status,200);
  const response=await request('/api/projects/'+alpha.id+'/repositories',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({project:beta.id,name:'Path wins'})});
  assert.equal(response.status,201);assert.equal((await response.json()).project_id,alpha.id);
  const basic=await fetch(url+'/api/dashboard/projects',{headers:{authorization:'Basic '+Buffer.from('admin:'+config.apiKey).toString('base64')}});
  assert.equal(basic.status,200);
  assert.equal((await request('/api/dashboard/memories?project='+beta.id+'&repositoryId='+backend.id)).status,400);
});
test('all dashboard views read scoped data through authenticated API',async()=>{
  for(const view of ['overview','projects','repositories','agents','sessions','tasks','memories','decisions','errors','checkpoints','timeline','graph','metrics','audit_log']) {
    const response=await request('/api/dashboard/'+view+'?project='+alpha.id);assert.equal(response.status,200,view);
    const json=await response.json();assert.ok(json);
  }
  const script=await request('/dashboard/app.js');assert.equal(script.status,200);assert.match(await script.text(),/textContent/);
});
test('dashboard browser renders core views on desktop/mobile without script errors',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true});
  try {
    const context=await browser.newContext({httpCredentials:{username:'admin',password:config.apiKey},viewport:{width:1440,height:1000}});
    const page=await context.newPage();const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/dashboard/');
    await page.selectOption('#project',alpha.id);
    for(const view of ['overview','projects','tasks','memories','decisions','errors','timeline','metrics']) {
      await page.click('[data-view="'+view+'"]');
      await page.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Consulta concluida'));
      assert.ok((await page.locator('#content').innerText()).length>0);
      assert.ok(!(await page.locator('body').innerText()).includes(config.apiKey));
      await page.screenshot({path:'/tmp/jatoba-dashboard-'+view+'.png',fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});
    await page.click('[data-view="overview"]');
    await page.waitForFunction(()=>document.getElementById('status')?.textContent?.startsWith('Consulta concluida'));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:'/tmp/jatoba-dashboard-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    await context.close();
  } finally {await browser.close();}
});
test('MCP protocol lists old and new tools and invokes recall',async()=>{
  const response=await request('/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  const text=await response.text();assert.equal(response.status,200,text);
  assert.match(text,/project_select/);assert.match(text,/context_retrieve/);
  assert.ok(Object.keys(toolRegistry).length>=34);
  const invocation=await request('/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'recall',arguments:{project:alpha.id,query:'authentication'}}})});
  assert.equal(invocation.status,200);assert.match(await invocation.text(),/authentication/);
});
test('stdio MCP retains a live database pool across calls',async()=>{
  const child=spawn(process.execPath,['--import','tsx','src/stdio.ts'],{env:process.env,stdio:['pipe','pipe','pipe']});
  const responses=new Map<number,(value:any)=>void>();let buffer='',nextId=0;
  child.stdout.on('data',chunk=>{
    buffer+=chunk;let newline;
    while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{const parsed=JSON.parse(line);responses.get(parsed.id)?.(parsed);}catch{}}
  });
  const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{
    const id=++nextId;const timer=setTimeout(()=>reject(new Error('stdio response timeout')),10000);
    responses.set(id,result=>{clearTimeout(timer);resolve(result);});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try {
    const initialized=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'integration',version:'1'}});
    assert.ok(initialized.result);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const result=await rpc('tools/call',{name:'recall',arguments:{project:alpha.id,query:'authentication'}});
    assert.equal(result.result.isError,undefined);assert.match(JSON.stringify(result),/authentication/);
  } finally {
    child.stdin.end();
    await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGTERM'),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
});
test('export contains architecture, decisions, solutions, timeline and handoff; workspace slugs are unambiguous',async()=>{
  await call('remember',{project:alpha.id,type:'ARCHITECTURE',title:'Runtime',content:'PostgreSQL remains primary memory'});
  const duplicate=await call('project_create',{name:'Alpha',workspace:'Other'});
  const docs=await buildDocuments(alpha.id);
  for(const file of ['PROJECT.md','ARCHITECTURE.md','DECISIONS.md','ERRORS-AND-SOLUTIONS.md','TIMELINE.md','HANDOFF.md'])assert.ok(docs[file]);
  assert.match(docs['ARCHITECTURE.md'],/PostgreSQL/);assert.match(docs['HANDOFF.md'],/Review expiry/);
  const first=await exportDocuments(alpha.id);const second=await exportDocuments(duplicate.id);
  assert.notEqual(path.dirname(first.directory),path.dirname(second.directory));
});
test('audit allowlist and real metrics never store arguments, secrets or exception details',async()=>{
  const marker='SECRET_PAYLOAD_SENTINEL';
  await call('remember',{project:beta.id,type:'GENERAL',content:marker,metadata:{password:marker}});
  const logs=(await sql('SELECT * FROM audit_log')).rows;
  assert.ok(logs.length>20);
  const serialized=JSON.stringify(logs);
  assert.ok(!serialized.includes(marker));assert.ok(!serialized.includes(config.apiKey));assert.ok(!serialized.includes(config.databaseUrl));
  const metrics=await call('metrics',{project:alpha.id});
  assert.ok(metrics.recalls>0);assert.ok(metrics.tasks_completed>0);assert.ok(metrics.context_items_returned>0);
  const result=await health();assert.equal(result.ok,true);assert.equal(result.pgvector,true);
});
test('reproducible internal benchmark records actual latency and result sources',async()=>{
  const observations=[];
  for(const [mode,options] of [
    ['rag',{include_structural_graph:false,include_work_graph:false,include_timeline:false}],
    ['graph',{include_semantic:false,include_timeline:false}],
    ['hybrid',{}],
  ] as const) {
    const start=performance.now();const result=await contextRetrieve({project:alpha.id,repositoryId:frontend.id,query:'Session',max_items:15,...options});
    observations.push({mode,elapsed_ms:Number((performance.now()-start).toFixed(2)),items:result.items_returned,sources:result.sources.map(s=>s.ref)});
  }
  console.log('BENCHMARK_FIXTURE '+JSON.stringify(observations));
  assert.ok(observations[1].items>0);
});
test('database restart preserves memory without removing volumes',async()=>{
  const before=Number((await sql('SELECT count(*) FROM memories')).rows[0].count);
  execFileSync('docker',['compose','-p',process.env.TEST_COMPOSE_PROJECT!,'-f',process.env.TEST_COMPOSE_FILE!,'restart','postgres'],
    {env:process.env,stdio:['ignore','pipe','pipe']});
  let afterCount=-1;
  for(let i=0;i<30;i++) {try{afterCount=Number((await sql('SELECT count(*) FROM memories')).rows[0].count);break;}catch{await new Promise(r=>setTimeout(r,500));}}
  assert.equal(afterCount,before);
  assert.equal((await health()).ok,true);
});
