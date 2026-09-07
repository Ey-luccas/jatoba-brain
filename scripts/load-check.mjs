import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, freemem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const exec = promisify(execFile);
const root = process.cwd();
const composeFile = 'docker-compose.test.yml';
const project = `jatoba-load-${process.pid}-${Date.now()}`;
const password = `load-pass-${randomUUID()}`;
const apiKey = `load-key-${randomUUID()}`;
const hostPort = 43000 + (process.pid % 1000);
const compose = (...args) => exec('docker', ['compose', '-p', project, '-f', composeFile, ...args], { cwd: root, env: { ...process.env, JATOBA_TEST_PASSWORD: password, JATOBA_TEST_API_KEY: apiKey, JATOBA_TEST_DB_PORT: String(hostPort), RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '100000', RATE_LIMIT_MCP_MAX: '100000', RATE_LIMIT_HEALTH_MAX: '100000' }, maxBuffer: 20 * 1024 * 1024 });
const sql = async (statement) => (await compose('exec', '-T', 'postgres', 'psql', '-U', 'jatoba', '-d', 'jatoba_test', '-At', '-c', statement)).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2));
}

function callTool(port, tool, input, options = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const body = JSON.stringify(input);
    const req = httpRequest({ hostname: '127.0.0.1', port, path: `/api/tools/${tool}`, method: 'POST', timeout: options.timeout ?? 10000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-jatoba-key': apiKey } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* measured as a protocol failure */ }
        resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) < 400, elapsed: performance.now() - started, body: parsed, raw: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', (error) => resolve({ status: 0, ok: false, elapsed: performance.now() - started, error: error.message }));
    req.end(body);
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await new Promise((resolve) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/ready', method: 'GET', timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve(0)); req.end();
    });
    if (result === 200) return;
    await sleep(1000);
  }
  throw new Error('Brain did not become ready');
}

async function seed() {
  const seedSql = `
DO $$ DECLARE w uuid; p uuid; r uuid; a text; t uuid;
BEGIN
  INSERT INTO workspaces(name, slug) VALUES ('Load Workspace','load-workspace') ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO w;
  FOR i IN 1..20 LOOP
    INSERT INTO projects(workspace_id,name,slug,description) VALUES (w,'Load Project '||i,'load-project-'||i,'Disposable performance fixture') ON CONFLICT(workspace_id,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO p;
    INSERT INTO repositories(project_id,name,slug,local_path) VALUES (p,'Repository 1','load-repository-1',NULL) ON CONFLICT(project_id,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO r;
    INSERT INTO repositories(project_id,name,slug,local_path) VALUES (p,'Repository 2','load-repository-2',NULL);
    FOR j IN 1..3 LOOP
      a := 'load-agent-'||i||'-'||j;
      INSERT INTO agents(key,name,role) VALUES (a,a,'load') ON CONFLICT(key) DO NOTHING;
      INSERT INTO tasks(project_id,repository_id,agent_key,title,description,status,priority,metadata) VALUES (p,r,a,'Load task '||j,'Synthetic load task','completed',5,'{}');
    END LOOP;
    FOR j IN 1..40 LOOP
      INSERT INTO memories(project_id,repository_id,agent_key,memory_type,title,content,importance,tags,source) VALUES (p,r,'load-agent-'||i||'-'||((j-1)%3+1),'FACT','Load memory '||j,'Synthetic authentication session context for project '||i||' item '||j,5,ARRAY['load','synthetic'],'load-check');
    END LOOP;
  END LOOP;
END $$;`;
  await compose('exec', '-T', 'postgres', 'psql', '-U', 'jatoba', '-d', 'jatoba_test', '-v', 'ON_ERROR_STOP=1', '-c', seedSql);
  const rows = await sql("SELECT json_agg(x) FROM (SELECT id, name FROM projects WHERE slug LIKE 'load-project-%' ORDER BY slug) x");
  return JSON.parse(rows);
}

async function sampleRuntime(port) {
  const health = await callTool(port, 'project_list', {});
  const docker = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}', `${project}-brain-1`, `${project}-postgres-1`], { maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: '' }));
  const connections = await sql("SELECT json_build_object('total',count(*),'active',count(*) FILTER (WHERE state='active'),'idle',count(*) FILTER (WHERE state='idle'),'waiting',count(*) FILTER (WHERE wait_event IS NOT NULL)) FROM pg_stat_activity WHERE datname='jatoba_test'").catch(() => '{}');
  return { host_free_mb: Math.round(freemem() / 1024 / 1024), host_total_mb: Math.round(totalmem() / 1024 / 1024), uptime_probe_ms: Number(health.elapsed.toFixed(2)), db_connections: JSON.parse(connections), docker_stats: docker.stdout.trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return line; } }) };
}

async function scenario(port, projects, index, name) {
  const projectId = projects[index % projects.length].id;
  const input = name === 'write' ? { project: projectId, agentKey: `load-agent-${(index % 20) + 1}-1`, type: 'FACT', content: `Synthetic write ${index}`, importance: 4 } :
    name === 'read' ? { project: projectId, query: 'authentication session', limit: 10, max_items: 10 } :
    { project: projectId, query: 'authentication session', max_items: 10, max_memories: 10, max_tasks: 5, include_structural_graph: false, include_work_graph: true, include_timeline: true };
  return callTool(port, name === 'write' ? 'remember' : name === 'read' ? 'recall' : 'context_retrieve', input);
}

async function runLevel(port, projects, scenarioName, concurrency, operations = 50) {
  const results = [];
  let next = 0;
  const worker = async (workerId) => { while (true) { const index = next++; if (index >= operations) return; results.push(await scenario(port, projects, index + workerId, scenarioName)); } };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const elapsed = (performance.now() - started) / 1000;
  const successful = results.filter((item) => item.ok);
  return { concurrency, operations: results.length, successful: successful.length, failed: results.length - successful.length,
    error_rate: Number(((results.length - successful.length) / Math.max(1, results.length)).toFixed(4)),
    p50_ms: percentile(results.map((item) => item.elapsed), 0.5), p95_ms: percentile(results.map((item) => item.elapsed), 0.95), p99_ms: percentile(results.map((item) => item.elapsed), 0.99),
    rps: Number((successful.length / Math.max(elapsed, 0.001)).toFixed(2)), elapsed_s: Number(elapsed.toFixed(2)),
    error_samples: results.filter((item) => !item.ok).slice(0, 3).map((item) => ({ status: item.status, error: item.error, body: item.body })) };
}

async function race(projects, port) {
  const projectId = projects[0].id;
  await sql("INSERT INTO agents(key,name,role) VALUES ('race-seed','race-seed','load') ON CONFLICT(key) DO NOTHING");
  const taskOutput = await sql(`INSERT INTO tasks(project_id,agent_key,title,status,priority,metadata) VALUES ('${projectId}','race-seed','Concurrent ownership race','pending',5,'{}') RETURNING id`);
  const taskId = taskOutput.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
  if (!taskId) throw new Error(`Could not parse race task id: ${taskOutput}`);
  const attempts = await Promise.all(['race-a', 'race-b'].map((agentKey) => callTool(port, 'task_assign', { project: projectId, taskId, agentKey })));
  return { task_id: taskId, claimed: attempts.filter((item) => item.ok && item.body?.claimed).length, conflicts: attempts.filter((item) => item.body?.reason === 'TASK_ALREADY_OWNED').length };
}

async function main() {
  const report = { generated_at: new Date().toISOString(), target: 'disposable local Docker environment', baseline: { cpus: cpus().length, node: process.version }, levels: [], scenarios: {}, checks: {} };
  try {
    await compose('up', '-d', '--build');
    const portInfo = await compose('port', 'brain', '3338');
    let port = Number(portInfo.stdout.trim().split(':').pop());
    await waitForHealth(port);
    const projects = await seed();
    report.baseline.postgres = await sql('SELECT version()');
    report.baseline.graphify = await compose('exec', '-T', 'brain', 'graphify', '--version').then((r) => r.stdout.trim()).catch((error) => `unavailable: ${error.message}`);
    report.baseline.runtime_start = await sampleRuntime(port);
    for (const scenarioName of ['read', 'write', 'mixed']) for (const concurrency of [1, 5, 10, 25, 50]) {
      const result = await runLevel(port, projects, scenarioName, concurrency);
      report.levels.push({ scenario: scenarioName, ...result });
      if (result.error_rate > 0.25 && concurrency >= 25) break;
    }
    report.checks.race = await race(projects, port);
    const unauthorizedStatus = await new Promise((resolve) => { const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/tools/project_list', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', () => resolve(0)); req.end('{}'); });
    report.checks.invalid_traffic = { unauthorized: unauthorizedStatus === 401 };
    const invalid = await new Promise((resolve) => { const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/tools/does-not-exist', method: 'POST', headers: { 'content-type': 'application/json', 'x-jatoba-key': apiKey } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', () => resolve(0)); req.end('{}'); });
    report.checks.invalid_traffic.not_found = invalid;
    await compose('restart', 'brain');
    port = Number((await compose('port', 'brain', '3338')).stdout.trim().split(':').pop());
    await waitForHealth(port);
    report.checks.restart_brain = true;
    await compose('restart', 'postgres');
    port = Number((await compose('port', 'brain', '3338')).stdout.trim().split(':').pop());
    await waitForHealth(port);
    report.checks.restart_postgres = true;
    report.baseline.runtime_end = await sampleRuntime(port);
    report.coverage = ['HTTP API load', 'synthetic multi-project dataset', 'ownership race', 'invalid traffic', 'Brain restart', 'PostgreSQL restart'];
    report.gaps = ['stdio stability was not exercised by this short HTTP harness', 'Graph indexing is intentionally excluded from the write/read workload', '30-minute soak must be run explicitly before claiming long-duration stability'];
    report.classification = { load_test: report.levels.every((item) => item.error_rate === 0) ? 'PASS' : 'GAP', multi_agent: report.checks.race.claimed === 1 && report.checks.race.conflicts === 1 ? 'PASS' : 'GAP', recovery_under_load: report.checks.restart_brain && report.checks.restart_postgres ? 'PASS' : 'GAP', soak: 'NOT_RUN_BY_LOAD_CHECK' };
    await mkdir('docs', { recursive: true });
    const previous = await readFile('docs/PERFORMANCE.md', 'utf8').catch(() => '');
    const preservedSections = previous.includes('## v0.7E Final Graphify Fixture Validation')
      ? `\n${previous.slice(previous.indexOf('## v0.7E Final Graphify Fixture Validation'))}`
      : '';
    await writeFile('docs/PERFORMANCE.md', `# Performance and Reliability\n\nGenerated by \`npm run test:load\` on ${report.generated_at}. This report contains measurements from a disposable local Docker dataset only; it is not a production SLO.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n${preservedSections}`);
    console.log(`LOAD_RESULT ${JSON.stringify(report)}`);
  } finally {
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
  }
}

main().catch((error) => { console.error(`LOAD_FAILED ${error.stack ?? error.message}`); process.exitCode = 1; });
