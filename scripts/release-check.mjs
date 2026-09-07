import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const project='jatoba-release-'+randomBytes(5).toString('hex');
const env={...process.env,JATOBA_TEST_PASSWORD:randomBytes(24).toString('hex'),JATOBA_TEST_API_KEY:randomBytes(32).toString('hex')};
const args=['compose','-p',project,'-f','docker-compose.test.yml'];
const docker=tail=>execFileSync('docker',[...args,...tail],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let url;
const keepAlive=setInterval(()=>{},1000);
const get=route=>fetch(url+route,{headers:{connection:'close'},signal:AbortSignal.timeout(5000)});
function postgresHealthy() {
  const id=docker(['ps','-q','postgres']);
  if(!id)return false;
  try {return execFileSync('docker',['inspect','--format={{.State.Health.Status}}',id],{encoding:'utf8'}).trim()==='healthy';}
  catch {return false;}
}
async function healthy() {
  for(let i=0;i<60;i++) {
    try {
      url='http://'+docker(['port','brain','3338']);
      const response=await get('/health');
      if(response.ok && postgresHealthy()) return await response.json();
    }catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error('Service did not become healthy');
}
async function tool(name,input) {
  const response=await fetch(url+'/api/tools/'+name,{method:'POST',signal:AbortSignal.timeout(10000),headers:{connection:'close','content-type':'application/json',authorization:'Bearer '+env.JATOBA_TEST_API_KEY},body:JSON.stringify(input)});
  assert.equal(response.status,200,name);return response.json();
}
try {
  docker(['up','-d','--build','--wait']);
  console.log('Isolated release containers started.');
  console.log(docker(['ps']));
  const first=await healthy();assert.equal(first.pgvector,true);assert.equal(first.graphify,true);
  const alpha=await tool('project_create',{name:'Release Alpha'}),beta=await tool('project_create',{name:'Release Beta'});
  const memory=await tool('remember',{project:alpha.id,type:'GENERAL',content:'persistent authentication memory'});
  assert.equal((await tool('recall',{project:beta.id,query:'authentication'})).length,0);
  for(const endpoint of ['/mcp','/api/projects','/dashboard/'])assert.equal((await get(endpoint)).status,401);
  const before=await tool('recall',{project:alpha.id,query:'authentication'});assert.equal(before[0].id,memory.id);
  for(let cycle=1;cycle<=5;cycle++) {
    docker(['restart']);
    await healthy();
    assert.equal((await tool('recall',{project:alpha.id,query:'authentication'}))[0].id,memory.id);
    console.log(`Restart cycle ${cycle}/5 passed; memory persisted.`);
  }
  const exported=await tool('export_docs',{project:alpha.id});assert.ok(exported.files.includes('ARCHITECTURE.md'));
  const timings={};
  for(const name of ['health','recall','context_retrieve']) {
    const start=performance.now();
    if(name==='health')await get('/health');else await tool(name,{project:alpha.id,query:'authentication'});
    timings[name+'_ms']=Number((performance.now()-start).toFixed(2));
  }
  const logs=docker(['logs','--no-color','brain']);
  assert.ok(!logs.includes(env.JATOBA_TEST_PASSWORD));assert.ok(!logs.includes(env.JATOBA_TEST_API_KEY));
  console.log('Container logs checked: no generated credentials found.');
  console.log('RELEASE_CONTAINER_CHECK '+JSON.stringify({persistence:true,isolation:true,auth:true,pgvector:true,graphify:true,export:true,restart:true,timings}));
} catch(error) {
  // Keep the check actionable without printing runtime secrets: inputs are never attached to errors.
  console.error(error instanceof Error?error.message:'Container release check failed');
  process.exitCode=1;
} finally {
  try{docker(['down','--remove-orphans']);console.log('Preserved release volume: '+project+'_test_postgres');}catch{console.error('Cleanup required for isolated project '+project);}
  clearInterval(keepAlive);
}
