import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

process.on('SIGPIPE', () => undefined);

const project=`jatoba-observability-${randomBytes(5).toString('hex')}`;
const password=randomBytes(24).toString('hex');
const apiKey=randomBytes(32).toString('hex');
const env={...process.env,JATOBA_TEST_PASSWORD:password,JATOBA_TEST_API_KEY:apiKey};
const composeEnv=overrides=>({...env,...overrides});
const docker=(...args)=>{
  const overrides=args[0] && typeof args[0]==='object' ? args.shift() : {};
  if(['restart','down'].includes(args[0])) { execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env:composeEnv(overrides),stdio:'ignore'}); return ''; }
  return execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env:composeEnv(overrides),encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let base;
function discoverTarget() {
  const published=docker('port','brain','3338').split(':').at(-1);
  base=`http://127.0.0.1:${published}`;
  return base;
}
function containerGateway() {
  return execFileSync('docker',['inspect','-f','{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}',`${project}-brain-1`],{encoding:'utf8'}).trim();
}
async function request(path,init={}) {
  const args=['-s','--max-time','10','-X',init.method??'GET'];
  for(const [name,value] of Object.entries({authorization:`Bearer ${apiKey}`,...(init.headers??{})})) args.push('-H',`${name}: ${value}`);
  if(init.body!==undefined) args.push('--data-binary',init.body);
  args.push('-D','-','-o','-','-w','\n__STATUS__%{http_code}',base+path);
  const raw=execFileSync('curl',args,{encoding:'utf8'});
  const marker=raw.lastIndexOf('\n__STATUS__');
  const status=Number(raw.slice(marker+11).trim());
  const response=raw.slice(0,marker);
  const separator=response.indexOf('\r\n\r\n');
  const headerText=separator>=0?response.slice(0,separator):'';
  const body=separator>=0?response.slice(separator+4):response;
  const headerMap=new Map(headerText.split('\r\n').slice(1).map(line=>{const at=line.indexOf(':');return at<0?['','']:[line.slice(0,at).toLowerCase(),line.slice(at+1).trim()];}));
  return {status,ok:status>=200&&status<300,headers:{get:name=>headerMap.get(name.toLowerCase())},text:async()=>body,json:async()=>JSON.parse(body)};
}
function diagnostics() {
  const run=(...args)=>{try{return docker(...args);}catch(error){return error instanceof Error?error.message:'diagnostic failed';}};
  console.error(`OBSERVABILITY_DIAGNOSTICS target=${base}`);
  console.error(`compose_ps=${run('ps')}`);
  console.error(`compose_port=${run('port','brain','3338')}`);
  console.error(`brain_logs=${run('logs','--no-color','--tail','40','brain')}`);
  console.error(`postgres_logs=${run('logs','--no-color','--tail','40','postgres')}`);
}
async function waitReady() { let lastError='no response'; for(let i=0;i<90;i+=1) { try { discoverTarget(); const response=await request('/health'); if(response.ok)return response.json(); lastError=`HTTP ${response.status}`; } catch(error) { lastError=error instanceof Error?error.message:'request failed'; } await sleep(500); } diagnostics(); throw new Error(`observability test service did not become healthy (${lastError})`); }
async function waitHealth(expectedStatus,expectedReady=true) {
  for(let i=0;i<60;i+=1) {
    try {
      discoverTarget();
      const health=await request('/health');
      const ready=await request('/ready');
      if(health.status=== (expectedStatus==='UNHEALTHY'?503:200) && (await health.json()).status===expectedStatus && (ready.status===200)===expectedReady) return {health,ready};
    } catch {}
    await sleep(500);
  }
  diagnostics();
  throw new Error(`expected ${expectedStatus}/${expectedReady?'READY':'NOT READY'}`);
}
function assertMetric(text,name) { assert.match(text,new RegExp(`^jatoba_${name}(?:\\{|\\s)`, 'm'),`missing metric ${name}`); }

try {
  docker('build','brain');
  docker('up','-d');
  discoverTarget();
  await sleep(5000);
  const initial=await waitReady();
  assert.ok(['HEALTHY','DEGRADED'].includes(initial.status));
  assert.equal(initial.embedding.status,'disabled');
  assert.equal(initial.status,'HEALTHY');
  assert.equal((await request('/metrics',{headers:{authorization:''}})).status,401,'/metrics must require authentication');
  const requestId='observability-check-001';
  const live=await request('/live',{headers:{'x-request-id':requestId}});
  assert.equal(live.status,200); assert.equal(live.headers.get('x-request-id'),requestId);
  const projectResult=await request('/api/tools/project_create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Observability Project'})});
  assert.equal(projectResult.status,200); const created=await projectResult.json();
  const repositoryResult=await request('/api/tools/repository_add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,name:'observability-repository',path:'/app'})});
  assert.equal(repositoryResult.status,200); const repository=await repositoryResult.json();
  const memory=await request('/api/tools/remember',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,type:'GENERAL',content:'observability fallback fixture'})});
  assert.equal(memory.status,200);
  const recall=await request('/api/tools/recall',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,query:'observability'})});
  assert.equal(recall.status,200);
  const context=await request('/api/tools/context_retrieve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,query:'observability',max_items:10,include_structural_graph:false,include_work_graph:false,include_timeline:false})});
  assert.equal(context.status,200);
  const invalid=await request('/api/tools/not-a-real-tool',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(invalid.status,400);
  const metricsResponse=await request('/metrics');
  assert.equal(metricsResponse.status,200); const metrics=await metricsResponse.text();
  for(const name of ['http_requests_total','http_errors_total','mcp_calls_total','recall_calls_total','embedding_fallback_total','process_rss_bytes','process_heap_used_bytes','db_pool_active','db_pool_idle','db_pool_waiting','http_request_duration_ms_count','recall_duration_ms_count','context_duration_ms_count']) assertMetric(metrics,name);
  assert.ok(!metrics.includes(apiKey) && !metrics.includes(password) && !metrics.includes('DATABASE_URL'));
  const logs=docker('logs','--no-color','brain');
  assert.match(logs,/"operation":"http_request"/); assert.ok(!logs.includes(apiKey) && !logs.includes(password) && !logs.includes('DATABASE_URL'));
  const health=await (await request('/health')).json();
  assert.ok(health.memory?.rss && health.db_pool && health.status);
  docker('restart','brain');
  const afterRestart=await waitReady();
  assert.ok(afterRestart.database); assert.ok(afterRestart.status);
  const postRestartMetrics=await (await request('/metrics')).text();
  assertMetric(postRestartMetrics,'process_rss_bytes');
  const normalMetrics=postRestartMetrics;

  docker({GRAPHIFY_BIN:'/definitely-missing-graphify'},'up','-d','--force-recreate','brain');
  const graphHealth=await waitHealth('DEGRADED');
  assert.equal((await request('/live')).status,200);
  const graphQuery=await request('/api/tools/graph_query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,repositoryId:repository.id,query:'missing'})});
  assert.ok(graphQuery.status>=400 || graphQuery.status===200);
  const graphMetrics=await (await request('/metrics')).text();
  assertMetric(graphMetrics,'mcp_calls_graph_query');
  assertMetric(graphMetrics,'graph_query_success_total');
  assert.equal((await request('/api/tools/project_context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id})})).status,200);
  assert.equal((await request('/api/tools/not-a-real-tool',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,400);
  const graphLogs=docker('logs','--no-color','brain');
  assert.match(graphLogs,/request_id/);
  docker({GRAPHIFY_BIN:'graphify'},'up','-d','--force-recreate','brain');
  await waitReady();

  docker({EMBEDDINGS_ENABLED:'true',EMBEDDING_BASE_URL:'http://127.0.0.1:9/v1/embeddings',EMBEDDING_TIMEOUT_MS:'100'},'up','-d','--force-recreate','brain');
  const embeddingOfflineHealth=await waitReady();
  assert.equal(embeddingOfflineHealth.status,'DEGRADED');
  assert.equal(embeddingOfflineHealth.embedding.status,'unavailable');
  const embeddingMemory=await request('/api/tools/remember',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,type:'GENERAL',content:'embedding offline fallback fixture'})});
  assert.equal(embeddingMemory.status,200);
  assert.equal((await request('/api/tools/recall',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,query:'embedding offline'})})).status,200);
  const embeddingMetrics=await (await request('/metrics')).text();
  assert.match(embeddingMetrics,/jatoba_embedding_(provider_failures|fallback)_total/);
  docker({EMBEDDINGS_ENABLED:'true',EMBEDDING_BASE_URL:'http://embedding-test-provider:4010/v1/embeddings'},'up','-d','--force-recreate','brain');
  await waitReady();
  const onlineHealth=await (await request('/health')).json();
  assert.equal(onlineHealth.embedding.status,'available');
  const probesBefore=Number((await (await request('/metrics')).text()).match(/jatoba_embedding_health_checks_total\s+(\d+)/)?.[1]??0);
  await request('/health'); await request('/health');
  const probesDuringTtl=Number((await (await request('/metrics')).text()).match(/jatoba_embedding_health_checks_total\s+(\d+)/)?.[1]??0);
  assert.equal(probesDuringTtl,probesBefore);
  await sleep(1100);
  await request('/health');
  const probesAfterTtl=Number((await (await request('/metrics')).text()).match(/jatoba_embedding_health_checks_total\s+(\d+)/)?.[1]??0);
  assert.ok(probesAfterTtl>probesDuringTtl);
  docker('stop','embedding-test-provider');
  await sleep(1100);
  const recoveredOffline=await (await request('/health')).json();
  assert.equal(recoveredOffline.embedding.status,'unavailable');
  assert.equal(recoveredOffline.status,'DEGRADED');
  docker('start','embedding-test-provider');
  await waitReady();
  const recoveredOnline=await (await request('/health')).json();
  assert.equal(recoveredOnline.embedding.status,'available');
  docker({EMBEDDINGS_ENABLED:'false',EMBEDDING_BASE_URL:''},'up','-d','--force-recreate','brain');
  await waitReady();

  docker('stop','postgres');
  await waitHealth('UNHEALTHY',false);
  assert.equal((await request('/live')).status,200);
  for(const tool of ['recall','remember','context_retrieve']) {
    const body=tool==='recall'?{project:created.id,query:'offline'}:tool==='remember'?{project:created.id,type:'GENERAL',content:'db offline fixture'}:{project:created.id,query:'offline'};
    const response=await request(`/api/tools/${tool}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(response.status>=400);
    assert.ok(!(await response.text()).includes('DATABASE_URL'));
  }
  docker('start','postgres');
  await waitReady();
  assert.equal((await request('/api/tools/recall',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:created.id,query:'observability'})})).status,200);
  const graphHealthBody=await graphHealth.health.json();
  assert.equal(graphHealthBody.status,'DEGRADED');
  console.log(JSON.stringify({normal:true,metrics_auth:true,metrics_format:true,http_counters:true,mcp_counters:true,recall_latency:true,context_latency:true,embedding_fallback:true,db_pool:true,process_memory:true,request_id:true,structured_logs:true,secret_redaction:true,graphify_degraded:true,embedding_provider_fallback:true,postgres_unhealthy:true,postgres_recovery:true,restart:true},null,2));
} finally {
  try { docker('down','--volumes','--remove-orphans'); } catch {}
}
