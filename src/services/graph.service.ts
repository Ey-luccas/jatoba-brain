import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { budget, resolveScope, type Scope } from './scope.js';
import { safeRepositoryPath } from './paths.js';

const exec = promisify(execFile);
export type GraphNode = { id: string; label: string; type: string; file?: string };
export type GraphEdge = { source: string; target: string; relation: string };
export type GraphInput = Scope & { repositoryId: string; query?: string; entity?: string; depth?: number; max_nodes?: number; max_edges?: number };
const git = async (root: string,args: string[]) => (await exec('git',['-C',root,...args],{timeout:5000,maxBuffer:2_000_000})).stdout.trim();

export async function graphifyAvailable() {
  try { await exec(config.graphifyBin,['--help'],{timeout:3000,maxBuffer:100_000,env:{PATH:process.env.PATH}}); return true; }
  catch { return false; }
}

async function repository(input: GraphInput) {
  const scope = await resolveScope({...input,scope:'repository'});
  return (await db.query('SELECT * FROM repositories WHERE id=$1 AND project_id=$2',[scope.repositoryId,scope.projectId])).rows[0];
}

export async function readGraph(file: string): Promise<{nodes:GraphNode[];edges:GraphEdge[]}> {
  const root = await realpath(config.graphDir);
  const target = await realpath(file);
  if (!target.startsWith(root+path.sep)) throw new Error('Graph path escapes GRAPH_DIR');
  if ((await stat(target)).size>20_000_000) throw new Error('Graph file exceeds 20 MB limit');
  const json = JSON.parse(await readFile(target,'utf8'));
  if (!Array.isArray(json.nodes) || !Array.isArray(json.edges ?? json.links)) throw new Error('Invalid graph format');
  if (json.nodes.length>100000 || (json.edges ?? json.links).length>300000) throw new Error('Graph exceeds ingestion limit');
  const nodes: GraphNode[] = json.nodes.map((n: Record<string,unknown>) => {
    if (typeof n.id!=='string') throw new Error('Invalid node id');
    return {id:n.id,label:String(n.label ?? n.name ?? n.id).slice(0,300),type:String(n.type ?? 'entity'),
      file:n.source_file || n.file ? String(n.source_file ?? n.file).slice(0,1000) : undefined};
  });
  const ids = new Set(nodes.map(n=>n.id));
  const edges: GraphEdge[] = (json.edges ?? json.links).map((e: Record<string,unknown>) => {
    if (!ids.has(String(e.source)) || !ids.has(String(e.target))) throw new Error('Dangling graph edge');
    return {source:String(e.source),target:String(e.target),relation:String(e.relation ?? e.type ?? 'RELATED_TO')};
  });
  return {nodes,edges};
}

export async function graphIndex(input: GraphInput) {
  const repo = await repository(input);
  const client = await db.connect();
  let generated: string | undefined;
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[repo.id])).rows[0].locked;
    if (!locked) return {status:'INDEXING',repository_id:repo.id};
    await client.query(`INSERT INTO repository_graphs(project_id,repository_id,status) VALUES($1,$2,'INDEXING')
      ON CONFLICT(repository_id) DO UPDATE SET status='INDEXING',updated_at=now(),error_code=NULL`,[repo.project_id,repo.id]);
    if (!repo.local_path) throw new Error('Repository has no local path');
    const root = await safeRepositoryPath(repo.local_path);
    const commit = await git(root,['rev-parse','HEAD']);
    if (await git(root,['status','--porcelain'])) throw new Error('Working tree must be clean for reproducible indexing');
    const dir = path.resolve(config.graphDir,repo.project_id,repo.id);
    await mkdir(dir,{recursive:true});
    generated = await mkdtemp(path.join(dir,'build-'));
    // Pinned Graphify CLI: deterministic AST extraction without LLM credentials.
    await exec(config.graphifyBin,['extract',root,'--code-only','--no-cluster','--max-workers','2','--out',generated],
      {timeout:120_000,maxBuffer:2_000_000,env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
    const file = path.join(generated,'graphify-out','graph.json');
    const graph = await readGraph(file);
    if (commit !== await git(root,['rev-parse','HEAD']) || await git(root,['status','--porcelain'])) throw new Error('Repository changed during indexing');
    const saved = (await client.query(`UPDATE repository_graphs SET status='READY',graph_path=$2,git_commit=$3,
      nodes_count=$4,edges_count=$5,generated_at=now(),updated_at=now(),error_code=NULL WHERE repository_id=$1 RETURNING *`,
      [repo.id,file,commit,graph.nodes.length,graph.edges.length])).rows[0];
    generated=undefined;
    return saved;
  } catch {
    await client.query("UPDATE repository_graphs SET status='ERROR',error_code='GRAPH_INDEX_FAILED',updated_at=now() WHERE repository_id=$1",[repo.id]);
    return {repository_id:repo.id,status:'ERROR',error_code:'GRAPH_INDEX_FAILED'};
  } finally {
    if (generated) await rm(generated,{recursive:true,force:true});
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[repo.id]);
    client.release();
  }
}

export async function graphStatus(input: GraphInput) {
  const repo = await repository(input);
  const row = (await db.query('SELECT * FROM repository_graphs WHERE repository_id=$1',[repo.id])).rows[0];
  if (!row) return {status:'MISSING',repository_id:repo.id};
  if (!row.graph_path) return {...row,status:'MISSING',graph_path:undefined};
  try { await stat(row.graph_path); } catch { return {...row,status:'MISSING',graph_path:undefined}; }
  let status = row.status;
  try {
    const root = await safeRepositoryPath(repo.local_path);
    if (row.git_commit && (row.git_commit!==await git(root,['rev-parse','HEAD']) || await git(root,['status','--porcelain']))) status='STALE';
  } catch { status='ERROR'; }
  return {...row,status,graph_path:undefined};
}

export function traverseGraph(graph: {nodes:GraphNode[];edges:GraphEdge[]}, input: Omit<GraphInput,'repositoryId'>, reverse=false) {
  const maxNodes=budget(input.max_nodes,20,100), maxEdges=budget(input.max_edges,30,200), depth=budget(input.depth,1,4);
  const query=(input.entity ?? input.query ?? '').toLowerCase();
  const tokens=query.split(/\s+/).filter(Boolean);
  const seeds=graph.nodes.filter(n=>n.id===query || tokens.some(t=>(n.label+' '+(n.file??'')).toLowerCase().includes(t))).slice(0,maxNodes);
  const ids=new Set(seeds.map(n=>n.id)); let frontier=new Set(ids); const edges: GraphEdge[]=[];
  const seenEdges=new Set<number>();
  for(let step=0;step<depth && frontier.size;step++) {
    const next=new Set<string>();
    for (const [i,e] of graph.edges.entries()) {
      const related=reverse ? frontier.has(e.target) : frontier.has(e.source)||frontier.has(e.target);
      if(!related || seenEdges.has(i)) continue;
      const additions=[e.source,e.target].filter(id=>!ids.has(id));
      if(ids.size+additions.length>maxNodes || edges.length>=maxEdges) continue;
      for(const id of additions) {ids.add(id);next.add(id);}
      edges.push(e);seenEdges.add(i);
    }
    frontier=next;
  }
  return {nodes:graph.nodes.filter(n=>ids.has(n.id)),edges,depth,limited:ids.size>=maxNodes||edges.length>=maxEdges};
}

export async function graphQuery(input: GraphInput, reverse=false) {
  const repo=await repository(input);
  const row=(await db.query('SELECT * FROM repository_graphs WHERE repository_id=$1',[repo.id])).rows[0];
  const status=await graphStatus(input);
  if(!row?.graph_path) return {...status,nodes:[],edges:[]};
  try {return {...status,...traverseGraph(await readGraph(row.graph_path),input,reverse)};}
  catch {return {status:'ERROR',repository_id:repo.id,nodes:[],edges:[],error_code:'GRAPH_UNAVAILABLE'};}
}
