import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appendFile } from 'node:fs/promises';
process.on('SIGPIPE', () => undefined);

const exec = promisify(execFile);
const composeProject = `jatoba-soak-${process.pid}-${Date.now()}`;
const password = `soak-pass-${randomUUID()}`;
const apiKey = `soak-key-${randomUUID()}`;
const durationMs = Number(process.env.SOAK_DURATION_MS ?? 30 * 60 * 1000);
const intervalMs = Number(process.env.SOAK_INTERVAL_MS ?? 250);
const env = { ...process.env, JATOBA_TEST_PASSWORD: password, JATOBA_TEST_API_KEY: apiKey, RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '100000', RATE_LIMIT_MCP_MAX: '100000', RATE_LIMIT_HEALTH_MAX: '100000' };
const compose = (...args) => exec('docker', ['compose', '-p', composeProject, '-f', 'docker-compose.test.yml', ...args], { env, maxBuffer: 12 * 1024 * 1024 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2)) : null; };

function call(port, tool, input, timeout = 10000) {
  return new Promise((resolve) => {
    const started = performance.now(); const body = JSON.stringify(input);
    const req = request({ hostname: '127.0.0.1', port, path: `/api/tools/${tool}`, method: 'POST', timeout, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-jatoba-key': apiKey } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; } resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body: parsed, ms: performance.now() - started }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', (error) => resolve({ ok: false, status: 0, error: error.message, ms: performance.now() - started })); req.end(body);
  });
}
async function waitReady(port) { for (let i = 0; i < 60; i += 1) { if ((await call(port, 'project_list', {})).ok) return; await sleep(1000); } throw new Error('soak service not ready'); }
async function sql(statement) { return (await compose('exec', '-T', 'postgres', 'psql', '-U', 'jatoba', '-d', 'jatoba_test', '-At', '-c', statement)).stdout.trim(); }
async function runtimeSample() {
  const proc = await compose('exec', '-T', 'brain', 'sh', '-c', "awk '/VmRSS|VmHWM/{print $1$2}' /proc/1/status").then((r) => r.stdout.trim()).catch(() => 'unavailable');
  const stats = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}', `${composeProject}-brain-1`, `${composeProject}-postgres-1`], { maxBuffer: 1024 * 1024 }).then((r) => r.stdout.trim()).catch(() => '');
  const connections = await sql("SELECT json_build_object('active',count(*) FILTER (WHERE state='active'),'idle',count(*) FILTER (WHERE state='idle'),'waiting',count(*) FILTER (WHERE wait_event IS NOT NULL)) FROM pg_stat_activity WHERE datname='jatoba_test'").catch(() => '{}');
  return { process_status: proc, db_connections: JSON.parse(connections), docker: stats.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return line; } }) };
}
async function operation(port, project, n) {
  const agent = `soak-agent-${n % 3}`; const choice = n % 9;
  if (choice === 0) return call(port, 'remember', { project, agentKey: agent, type: 'FACT', content: `Soak memory ${n}`, importance: 4 });
  if (choice === 1) return call(port, 'start_task', { project, agentKey: agent, title: `Soak task ${n}` }).then(async (started) => started.ok ? call(port, 'finish_task', { project, taskId: started.body.id, agentKey: agent, summary: `Soak task ${n} completed` }) : started);
  if (choice === 2) return call(port, 'checkpoint', { project, agentKey: agent, title: `Soak checkpoint ${n}`, summary: 'Synthetic controlled soak checkpoint' });
  if (choice === 3) return call(port, 'project_context', { project, max_items: 10, max_tasks: 5, max_decisions: 5, max_errors: 5 });
  if (choice === 4) return call(port, 'context_retrieve', { project, query: 'soak memory context', max_items: 10, max_memories: 10, max_tasks: 5, max_decisions: 5, max_errors: 5, include_structural_graph: false, include_work_graph: true, include_timeline: true });
  if (choice === 5) return call(port, 'project_timeline', { project, limit: 10 });
  if (choice === 6) return call(port, 'relations_query', { project, limit: 10 });
  if (choice === 7) return call(port, 'metrics', { project });
  return call(port, 'recall', { project, query: 'soak memory context', limit: 10, max_items: 10 });
}
async function main() {
  const report = { generated_at: new Date().toISOString(), requested_duration_ms: durationMs, interval_ms: intervalMs, operations: 0, successes: 0, failures: 0, latencies_ms: [], samples: [], budgets_violated: 0 };
  try {
    await compose('up', '-d', '--build'); const port = Number((await compose('port', 'brain', '3338')).stdout.trim().split(':').pop()); await waitReady(port);
    const project = (await call(port, 'project_create', { name: 'Soak Project', slug: `soak-${process.pid}`, workspace: 'soak-workspace' })).body; const projectId = project.id;
    for (let i = 0; i < 3; i += 1) await call(port, 'agent_register', { key: `soak-agent-${i}`, name: `soak-agent-${i}`, role: 'load' });
    const started = Date.now(); let nextSample = started; let n = 0;
    while (Date.now() - started < durationMs) { const result = await operation(port, projectId, n++); report.operations += 1; result.ok ? report.successes += 1 : report.failures += 1; report.latencies_ms.push(result.ms); if (result.body?.items_returned > 10 || result.body?.items?.length > 10) report.budgets_violated += 1; if (Date.now() >= nextSample) { report.samples.push({ elapsed_ms: Date.now() - started, runtime: await runtimeSample() }); nextSample += 10 * 60 * 1000; } await sleep(intervalMs); }
    report.samples.push({ elapsed_ms: Date.now() - started, runtime: await runtimeSample() }); report.elapsed_ms = Date.now() - started; report.p50_ms = percentile(report.latencies_ms, .5); report.p95_ms = percentile(report.latencies_ms, .95); report.p99_ms = percentile(report.latencies_ms, .99); report.avg_rps = Number((report.successes / (report.elapsed_ms / 1000)).toFixed(2)); report.error_rate = Number((report.failures / Math.max(1, report.operations)).toFixed(4));
    report.data_integrity = JSON.parse(await sql("SELECT json_build_object('memory_edges', (SELECT count(*) FROM memory_edges), 'work_events', (SELECT count(*) FROM work_events), 'cross_project_repositories', (SELECT count(*) FROM repositories r JOIN projects p ON p.id=r.project_id WHERE r.project_id<>p.id))")); report.memory_classification = 'INCONCLUSIVE_WITHOUT_HEAP_TELEMETRY'; report.classification = report.elapsed_ms >= durationMs && report.error_rate === 0 && report.budgets_violated === 0 ? 'PASS' : 'DEGRADED';
    await appendFile('docs/PERFORMANCE.md', `\n\n## 30-minute Soak\n\nGenerated by \`npm run test:soak\`; process heap telemetry is not exposed by the current runtime, so memory stability is not overclaimed.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`); console.log(`SOAK_RESULT ${JSON.stringify(report)}`);
  } finally { await compose('down', '-v', '--remove-orphans').catch(() => undefined); }
}
await main().catch((error) => { console.error(`SOAK_FAILED ${error.stack ?? error.message}`); process.exitCode = 1; });
