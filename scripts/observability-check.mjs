import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

process.on('SIGPIPE', () => undefined);

const project=`jatoba-observability-${randomBytes(5).toString('hex')}`;
const password=randomBytes(24).toString('hex');
const apiKey=randomBytes(32).toString('hex');
const env={...process.env,JATOBA_TEST_PASSWORD:password,JATOBA_TEST_API_KEY:apiKey};
const docker=(...args)=>{
  if(['restart','down'].includes(args[0])) { execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env,stdio:'ignore'}); return ''; }
  return execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let base;
function discoverTarget() {
  const published=docker('port','brain','3338').split(':').at(-1);
  base=`http://127.0.0.1:${published}`;
  return base;
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
function assertMetric(text,name) { assert.match(text,new RegExp(`^jatoba_${name}(?:\\{|\\s)`, 'm'),`missing metric ${name}`); }

try {
  docker('up','-d');
  discoverTarget();
  await sleep(5000);
  const initial=await waitReady();
  assert.ok(['HEALTHY','DEGRADED'].includes(initial.status));
  assert.equal((await request('/metrics',{headers:{authorization:''}})).status,401,'/metrics must require authentication');
  const requestId='observability-check-001';
  const live=await request('/live',{headers:{'x-request-id':requestId}});
  assert.equal(live.status,200); assert.equal(live.headers.get('x-request-id'),requestId);
  const projectResult=await request('/api/tools/project_create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Observability Project'})});
  assert.equal(projectResult.status,200); const created=await projectResult.json();
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
  console.log(JSON.stringify({metrics_auth:true,metrics_format:true,http_counters:true,mcp_counters:true,recall_latency:true,context_latency:true,embedding_fallback:true,db_pool:true,process_memory:true,request_id:true,structured_logs:true,secret_redaction:true,degradation_status:true,restart:true},null,2));
} finally {
  try { docker('down','--volumes','--remove-orphans'); } catch {}
}
