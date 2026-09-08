import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const external=process.env.HANDOFF_EXTERNAL_STACK==='1';
const scriptPath=fileURLToPath(import.meta.url);
const marker=(name)=>`${name}-${process.env.HANDOFF_RUN_ID??'standalone'}`;
const project=`jatoba-handoff-${randomBytes(5).toString('hex')}`;
const password=randomBytes(24).toString('hex');
const apiKey=process.env.BRAIN_API_KEY??randomBytes(32).toString('hex');
const env={...process.env,JATOBA_TEST_PASSWORD:password,JATOBA_TEST_API_KEY:apiKey};
process.on('SIGPIPE',()=>console.error('PARENT RECEIVED SIGPIPE'));
process.on('uncaughtException',error=>{console.error(`HANDOFF_UNCAUGHT ${error.message}`);process.exitCode=1;});
process.on('unhandledRejection',error=>{console.error(`HANDOFF_REJECTION ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;});
const compose=(...args)=>args[0]==='port'
  ? execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  : (execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml',...args],{env,stdio:'ignore'}),'');
let base=process.env.BRAIN_URL??process.env.HANDOFF_BASE;
const request=async(tool,input)=>{const response=await fetch(`${base}/api/tools/${tool}`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});const body=await response.text();if(!response.ok)throw new Error(`${tool} failed (${response.status}): ${body}`);return JSON.parse(body);};
const ready=async()=>{for(let i=0;i<90;i++){try{if(!external)base=`http://127.0.0.1:${compose('port','brain','3338').split(':').at(-1)}`;if((await fetch(`${base}/ready`)).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('handoff service did not become ready');};
function runChild(label,role,projectId,extraEnv={}) {
  return new Promise((resolve,reject)=>{
    const startedAt=new Date().toISOString();
    const child=spawn(process.execPath,[scriptPath,`--${role}`,projectId],{shell:false,env:{...env,HANDOFF_BASE:base,...extraEnv},stdio:['ignore','pipe','pipe']});
    let stdout='';let stderr='';let exitCode=null;let signal=null;let settled=false;
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    child.on('error',error=>{if(!settled){settled=true;reject(new Error(`${label} error pid=${child.pid}: ${error.message}`));}});
    child.on('exit',(code,receivedSignal)=>{exitCode=code;signal=receivedSignal;});
    child.on('close',(code,receivedSignal)=>{exitCode??=code;signal??=receivedSignal;settled=true;const result={label,pid:child.pid,startedAt,endedAt:new Date().toISOString(),exitCode,signal,stdout,stderr};if(exitCode!==0||signal)reject(Object.assign(new Error(`${label} failed`),{result}));else resolve(result);});
  });
}
async function actor(role,projectId){const call=async(tool,input)=>request(tool,{...input,project:projectId});if(role==='a'){
  const agent=await request('agent_register',{key:'handoff-agent-a',name:'Handoff Agent A',role:'builder',capabilities:['memory']});
  await request('project_select',{actor:agent.key,project:projectId});
  const session=await call('session_start',{agentKey:agent.key,title:'Process A'});
  const task=await call('start_task',{agentKey:agent.key,title:'Independent handoff task',description:'Persisted process handoff fixture'});
  await call('remember',{agentKey:agent.key,type:'GENERAL',content:marker('HANDOFF_MEMORY_MARKER_A')});
  const decision=await call('record_decision',{agentKey:agent.key,taskId:task.id,title:'Handoff decision',decision:marker('HANDOFF_DECISION_MARKER_A')});
  const error=await call('record_error',{agentKey:agent.key,taskId:task.id,title:'Handoff error',error:marker('HANDOFF_ERROR_MARKER_A')});
  const solution=await call('record_solution',{agentKey:agent.key,errorId:error.id,solution:marker('HANDOFF_SOLUTION_MARKER_A')});
  const checkpoint=await call('checkpoint',{agentKey:agent.key,taskId:task.id,title:'Handoff checkpoint',summary:marker('HANDOFF_CHECKPOINT_MARKER_A')});
  await call('session_finish',{sessionId:session.id,summary:'Process A persisted handoff state',promoteToMemory:true});
  return {task,decision,error,solution,checkpoint};
} await request('project_select',{actor:'handoff-agent-b',project:projectId});const session=await call('session_start',{agentKey:'handoff-agent-b',title:'Process B'});const context=await call('project_context',{max_items:100,max_tasks:10,max_decisions:10,max_errors:10});const memory=await call('recall',{query:marker('HANDOFF_MEMORY_MARKER_A'),max_items:10});const retrieved=await call('context_retrieve',{query:marker('HANDOFF'),max_items:100,include_structural_graph:false,include_work_graph:true,include_timeline:true});const timeline=await call('task_timeline',{taskId:process.env.HANDOFF_TASK_ID,limit:30});const continuation=await call('checkpoint',{agentKey:'handoff-agent-b',taskId:process.env.HANDOFF_TASK_ID,title:'Process B continuation',summary:marker('B-CONTINUATION')});await call('session_finish',{sessionId:session.id,summary:'Process B recovered and continued handoff'});return {context,memory,retrieved,timeline,continuation};}
if(process.argv[2]==='--a'){try{const state=await actor('a',process.argv[3]);console.log(JSON.stringify(state));}catch(error){console.error(error);process.exitCode=1;}}
else if(process.argv[2]==='--b'){try{const state=await actor('b',process.argv[3]);console.log(JSON.stringify(state));}catch(error){console.error(error);process.exitCode=1;}}
else {try{if(!external){compose('up','-d');}await ready();const projectResult=await request('project_create',{name:'Independent Handoff Project'});const projectId=projectResult.id;const runId=randomBytes(6).toString('hex');
  const processA=await runChild('PROCESS_A','a',projectId,{HANDOFF_RUN_ID:runId});assert.equal(processA.exitCode,0);const state=JSON.parse(processA.stdout);const processB=await runChild('PROCESS_B','b',projectId,{HANDOFF_TASK_ID:state.task.id,HANDOFF_RUN_ID:runId});assert.notEqual(processA.pid,processB.pid);const recovered=JSON.parse(processB.stdout);const serialized=JSON.stringify(recovered);for(const expected of ['HANDOFF_MEMORY_MARKER_A','HANDOFF_DECISION_MARKER_A','HANDOFF_ERROR_MARKER_A','HANDOFF_SOLUTION_MARKER_A','HANDOFF_CHECKPOINT_MARKER_A',`B-CONTINUATION`])assert.match(serialized,new RegExp(`${expected}-${runId}`));console.log(JSON.stringify({run_id:runId,process_a_pid:processA.pid,process_a_exit:processA.exitCode,process_a_signal:processA.signal,process_b_pid:processB.pid,process_b_exit:processB.exitCode,process_b_signal:processB.signal,different_processes:true,recovery:true,continuation:true,sigpipe:false},null,2));
}catch(error){console.error(error.result??error);process.exitCode=1;}finally{if(!external){try{compose('down','--volumes','--remove-orphans');}catch{}}}}
