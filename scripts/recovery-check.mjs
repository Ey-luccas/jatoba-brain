import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const suffix=randomBytes(5).toString('hex');
const sourceProject=`jatoba-recovery-source-${suffix}`;
const targetProject=`jatoba-recovery-target-${suffix}`;
const temp=await mkdtemp(path.join(os.tmpdir(),'jatoba-recovery-'));
const password=randomBytes(24).toString('hex');
const apiKey=randomBytes(32).toString('hex');
const envFile=path.join(temp,'recovery.env');
const env={...process.env,JATOBA_TEST_PASSWORD:password,JATOBA_TEST_API_KEY:apiKey};
await writeFile(envFile,`POSTGRES_DB=jatoba_test\nPOSTGRES_USER=jatoba\nPOSTGRES_PASSWORD=${password}\nBRAIN_API_KEY=${apiKey}\n`,'utf8');

function docker(project,...args) {
  return execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function composeEnv(extra={}) { return {...env,BACKUP_ENV_FILE:envFile,COMPOSE_FILE:'docker-compose.test.yml',COMPOSE_PROJECT_NAME:sourceProject,...extra}; }
function command(file,args,extra={}) { return execFileSync('bash',[file,...args],{env:{...env,...extra},encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
function port(project) { return Number(docker(project,'port','brain','3338').split(':').at(-1)); }
async function api(base,name,input) {
  try {
    return JSON.parse(execFileSync('curl',['-fsS','--max-time','10','-X','POST','-H',`authorization: Bearer ${apiKey}`,'-H','content-type: application/json','--data-binary',JSON.stringify(input),`${base}/api/tools/${name}`],{encoding:'utf8'}));
  } catch(error) {
    throw new Error(`${name} failed: ${error.message}`);
  }
}
async function health(base) {
  for(let attempt=1;attempt<=20;attempt+=1) {
    try { return JSON.parse(execFileSync('curl',['-fsS','--max-time','2',`${base}/health`],{encoding:'utf8'})); }
    catch (error) { if(attempt===20) console.error(`Health attempt failed: ${error}`); }
    await new Promise((resolve)=>setTimeout(resolve,500));
  }
  throw new Error(`health failed after retries: ${base}`);
}
function psql(project,sql) {
  return docker(project,'exec','-T','postgres','sh','-c','export PGPASSWORD="$POSTGRES_PASSWORD"; psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At').trim();
}
function psqlInput(project,sql) {
  return execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml','exec','-T','postgres','sh','-c','export PGPASSWORD="$POSTGRES_PASSWORD"; psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],{env,input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
}
function waitForPostgres(project) {
  for(let attempt=1;attempt<=30;attempt+=1) {
    try { docker(project,'exec','postgres','sh','-c','pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'); return; }
    catch { execFileSync('sleep',['1']); }
  }
  throw new Error(`PostgreSQL did not become ready in ${project}`);
}
async function counts(project) {
  const tables=['workspaces','projects','repositories','agents','sessions','tasks','memories','decisions','errors','solutions','checkpoints','changes','repository_graphs','work_entities','memory_edges','work_events','audit_log','schema_migrations'];
  const result={};
  for(const table of tables) result[table]=Number(psqlInput(project,`SELECT count(*) FROM ${table};`));
  return result;
}
function assertSameCounts(before,after) {
  for(const [table,count] of Object.entries(before)) if(count!==after[table]) throw new Error(`count mismatch for ${table}: ${count} != ${after[table]}`);
}
async function expectFailure(fn,label) {
  try { await fn(); throw new Error(`${label} unexpectedly succeeded`); } catch(error) {
    if(String(error.message).includes('unexpectedly succeeded')) throw error;
    console.log(`${label}: rejected as expected`);
  }
}

try {
  console.log(`Recovery source: ${sourceProject}`);
  docker(sourceProject,'up','-d','--build','--wait');
  const sourceBase=`http://127.0.0.1:${port(sourceProject)}`;
  console.log(`Source health: ${sourceBase}`);
  await health(sourceBase);
  console.log('Source is healthy.');
  console.log('Seeding recovery fixture.');
  const project=await api(sourceBase,'project_create',{name:'Jatoba Recovery Test',slug:'recovery-test',workspace:'recovery-lab'});
  const repository=await api(sourceBase,'repository_add',{project:project.id,name:'backend',slug:'backend',path:'/workspace/backend'});
  await api(sourceBase,'agent_register',{key:'recovery-agent',name:'Recovery Agent',role:'testes',provider:'local',model:'none',capabilities:['recovery']});
  const session=await api(sourceBase,'session_start',{project:project.id,agentKey:'recovery-agent',repositoryId:repository.id,title:'Recovery session'});
  const task=await api(sourceBase,'start_task',{project:project.id,repositoryId:repository.id,sessionId:session.id,agentKey:'recovery-agent',title:'Validate recovery'});
  const memory=await api(sourceBase,'remember',{project:project.id,repositoryId:repository.id,taskId:task.id,sessionId:session.id,agentKey:'recovery-agent',type:'GENERAL',title:'Recovery memory',content:'Recovery memory and embedding metadata must survive restore.'});
  const decision=await api(sourceBase,'record_decision',{project:project.id,repositoryId:repository.id,taskId:task.id,sessionId:session.id,agentKey:'recovery-agent',title:'Database backup',decision:'Use PostgreSQL custom dump for recovery.'});
  const error=await api(sourceBase,'record_error',{project:project.id,repositoryId:repository.id,taskId:task.id,sessionId:session.id,agentKey:'recovery-agent',title:'Recovery rehearsal',error:'Disposable target starts empty.',cause:'Recovery test setup.'});
  const solution=await api(sourceBase,'record_solution',{project:project.id,repositoryId:repository.id,taskId:task.id,sessionId:session.id,agentKey:'recovery-agent',errorId:error.id,solution:'Restore the verified custom dump into a fresh container.'});
  await api(sourceBase,'finish_task',{project:project.id,taskId:task.id,agentKey:'recovery-agent',summary:'Recovery fixture completed.',filesChanged:[{path:'src/recovery.ts',action:'A'}],commitHash:'recovery-commit',branch:'recovery-test',tests:{recovery:true}});
  const checkpoint=await api(sourceBase,'checkpoint',{project:project.id,repositoryId:repository.id,taskId:task.id,sessionId:session.id,agentKey:'recovery-agent',title:'Recovery checkpoint',summary:'Fixture is ready for backup.',commitHash:'recovery-commit',branch:'recovery-test',tests:{recovery:true}});
  await api(sourceBase,'agent_handoff',{project:project.id,repositoryId:repository.id,from_agent:'recovery-agent',to_agent:'recovery-reviewer',taskId:task.id});
  const safeIds=[project.id,repository.id,session.id,task.id,memory.id,decision.id,error.id,solution.id,checkpoint.id];
  if(safeIds.some((id)=>!/^[0-9a-f-]{36}$/i.test(id))) throw new Error('fixture returned an invalid identifier');
  psqlInput(sourceProject,`UPDATE memories SET embedding='[1,0,0]'::vector, embedding_provider='recovery-fixture', embedding_model='recovery-model', embedding_dimension=3, embedding_version='1' WHERE id='${memory.id}';\nINSERT INTO repository_graphs(project_id,repository_id,graph_path,git_commit,status,nodes_count,edges_count) VALUES ('${project.id}','${repository.id}','/workspace/graphs/recovery.json','recovery-commit','READY',1,1);`);
  const before=await counts(sourceProject);
  const backupDir=path.join(temp,'backups');
  console.log('Creating PostgreSQL backup.');
  const backupStarted=Date.now();
  command('scripts/backup.sh',[],{...composeEnv({BACKUP_DIR:backupDir})});
  const backupDurationMs=Date.now()-backupStarted;
  const metadataPath=path.join(backupDir,new Date().toISOString().slice(0,10),'metadata.json');
  const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
  const dump=path.join(path.dirname(metadataPath),metadata.dump_file);
  const stat=await readFile(dump); if(!stat.length) throw new Error('backup dump is empty');
  console.log(`Backup created: ${dump} (${stat.length} bytes)`);
  console.log(`Backup metadata migrations: ${metadata.migration_version}`);
  const corrupted=`${dump}.corrupt`; await copyFile(dump,corrupted); const bytes=await readFile(corrupted); bytes[bytes.length-1]^=255; await writeFile(corrupted,bytes);
  await expectFailure(()=>command('scripts/restore.sh',[corrupted,'--yes-i-know-this-overwrites-data'],{RESTORE_TARGET:'disposable',RESTORE_CONTAINER:'missing-before-target'}),'corrupted backup checksum');
  await expectFailure(()=>command('scripts/restore.sh',[`${dump}.missing`,'--yes-i-know-this-overwrites-data'],{RESTORE_TARGET:'disposable',RESTORE_CONTAINER:'missing-before-target'}),'missing backup');
  console.log(`Recovery target: ${targetProject}`);
  docker(targetProject,'up','-d','--wait','postgres');
  waitForPostgres(targetProject);
  const targetContainer=docker(targetProject,'ps','-q','postgres');
  const restoreStarted=Date.now();
  command('scripts/restore.sh',[dump,'--yes-i-know-this-overwrites-data'],{RESTORE_TARGET:'disposable',RESTORE_CONTAINER:targetContainer,RESTORE_DB:'jatoba_test',RESTORE_USER:'jatoba'});
  const restoreDurationMs=Date.now()-restoreStarted;
  docker(targetProject,'up','-d','--wait','brain');
  const targetBase=`http://127.0.0.1:${port(targetProject)}`;
  await health(targetBase);
  docker(targetProject,'exec','-T','brain','node','dist/migrate.js');
  const after=await counts(targetProject); assertSameCounts(before,after);
  const restoredMemory=Number(psqlInput(targetProject,`SELECT count(*) FROM memories WHERE id='${memory.id}' AND embedding_provider='recovery-fixture' AND embedding_model='recovery-model' AND embedding_dimension=3 AND embedding_version='1' AND embedding IS NOT NULL;`));
  if(restoredMemory!==1) throw new Error('embedding vector or metadata did not survive restore');
  const migrations=psqlInput(targetProject,"SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations;");
  if(migrations!=='001_foundation.sql,002_graphs.sql,003_observability.sql,004_runtime_contracts.sql,005_embedding_metadata.sql') throw new Error(`unexpected migration history: ${migrations}`);
  const functional={
    recall:(await api(targetBase,'recall',{project:project.id,query:'recovery memory'})).length>0,
    project_context:Boolean((await api(targetBase,'project_context',{project:project.id})).project),
    relations_query:(await api(targetBase,'relations_query',{project:project.id,source:{type:'TASK',id:task.id}})).length>0,
    context_retrieve:(await api(targetBase,'context_retrieve',{project:project.id,query:'recovery',include_structural_graph:false})).items_returned>0,
    agent_handoff:Boolean((await api(targetBase,'agent_handoff',{project:project.id,from_agent:'recovery-agent',to_agent:'recovery-reviewer',taskId:task.id})).last_checkpoint),
    export_docs:(await api(targetBase,'export_docs',{project:project.id})).files.length>0,
  };
  if(Object.values(functional).some((value)=>!value)) throw new Error(`functional recovery failed: ${JSON.stringify(functional)}`);
  const graphStatus=await api(targetBase,'graph_status',{project:project.id,repositoryId:repository.id,entity:'Recovery'});
  if(!['MISSING','STALE','ERROR'].includes(graphStatus.status)) throw new Error(`unexpected graph status after restore: ${graphStatus.status}`);
  console.log(JSON.stringify({backup:true,backup_size_bytes:stat.length,backup_duration_ms:backupDurationMs,restore_duration_ms:restoreDurationMs,checksum:true,corrupt_rejected:true,missing_rejected:true,before,after,embedding:true,migrations,graph_status:graphStatus.status,functional},null,2));
} finally {
  try {docker(sourceProject,'down','--remove-orphans');} catch {}
  try {docker(targetProject,'down','--remove-orphans');} catch {}
  await rm(temp,{recursive:true,force:true});
}
