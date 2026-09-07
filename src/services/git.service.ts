import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { safeRepositoryPath } from './paths.js';
import { resolveScope, type Scope } from './scope.js';

const exec = promisify(execFile);
export async function gitSnapshot(relativePath: string, input: Scope & {taskId?:string;agentKey?:string} = {}) {
  const repoPath = await safeRepositoryPath(relativePath);
  const git = async (args:string[]) => (await exec('git',['-C',repoPath,...args],{maxBuffer:2_000_000,timeout:5000})).stdout;
  const [branch,commit,status,diffStat] = await Promise.all([
    git(['rev-parse','--abbrev-ref','HEAD']),git(['rev-parse','HEAD']),
    git(['status','--porcelain=v1','-z']),git(['diff','--stat']),
  ]);
  const parts=status.split('\0'); const files:Array<{path:string;action:string}>=[];
  for(let i=0;i<parts.length;i++) {
    const item=parts[i]; if(!item) continue;
    files.push({path:item.slice(3),action:item.slice(0,2)});
    if(/[RC]/.test(item.slice(0,2))) i++;
  }
  const result={repository_path:relativePath,branch:branch.trim(),commit:commit.trim(),dirty:files.length>0,
    status:files.map(f=>f.action+' '+f.path),diff_stat:diffStat.trim().slice(0,8000),
    changed_files:files.slice(0,200),truncated:files.length>200,captured_at:new Date().toISOString()};
  if(input.taskId) {
    const scope=await resolveScope(input);
    const task=(await db.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2',[input.taskId,scope.projectId])).rows[0];
    if(!task?.repository_id) throw new Error('Task requires a repository for Git snapshot');
    if(scope.repositoryId && scope.repositoryId!==task.repository_id) throw new Error('Task repository mismatch');
    const repo=(await db.query('SELECT * FROM repositories WHERE id=$1',[task.repository_id])).rows[0];
    if(!repo.local_path || await safeRepositoryPath(repo.local_path)!==repoPath) throw new Error('Git path differs from task repository');
    await db.query(`INSERT INTO changes(project_id,repository_id,task_id,agent_key,commit_hash,branch,changed_files,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[task.project_id,repo.id,task.id,input.agentKey??task.agent_key,result.commit,result.branch,
        JSON.stringify(result.changed_files),{source:'git_snapshot',truncated:result.truncated}]);
  }
  return result;
}
