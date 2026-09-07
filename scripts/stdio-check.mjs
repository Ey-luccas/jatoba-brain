import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
process.on('SIGPIPE', () => undefined);

const exec = promisify(execFile); const project = `jatoba-stdio-${process.pid}-${Date.now()}`; const password = `stdio-pass-${randomUUID()}`; const apiKey = `stdio-key-${randomUUID()}`;
const env = { ...process.env, JATOBA_TEST_PASSWORD: password, JATOBA_TEST_API_KEY: apiKey, RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '100000', RATE_LIMIT_MCP_MAX: '100000' };
const compose = (...args) => exec('docker', ['compose', '-p', project, '-f', 'docker-compose.test.yml', ...args], { env, maxBuffer: 8 * 1024 * 1024 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function http(port, tool, input) { return new Promise((resolve) => { const body = JSON.stringify(input); const req = fetch(`http://127.0.0.1:${port}/api/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jatoba-key': apiKey }, body }).then(async (r) => resolve(await r.json())).catch(() => resolve(null)); }); }
async function main() {
  const report = { calls: 0, failures: 0, max_concurrency: 1, latencies_ms: [], db_connections: null, classification: 'FAIL' };
  try {
    await compose('up', '-d', '--build'); const port = Number((await compose('port', 'brain', '3338')).stdout.trim().split(':').pop()); const dbPort = Number((await compose('port', 'postgres', '5432')).stdout.trim().split(':').pop());
    for (let i = 0; i < 60; i += 1) { if (await http(port, 'project_list', {})) break; await sleep(500); }
    const created = await http(port, 'project_create', { name: 'Stdio Project', slug: `stdio-${process.pid}`, workspace: 'stdio-workspace' }); const projectId = created.id;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/stdio.ts'], { cwd: process.cwd(), env: { ...env, DATABASE_URL: `postgresql://jatoba:${password}@127.0.0.1:${dbPort}/jatoba_test`, BRAIN_API_KEY: apiKey, EMBEDDINGS_ENABLED: 'false', WORKSPACE_DIR: '/tmp/jatoba-stdio-workspace', GRAPH_DIR: '/tmp/jatoba-stdio-graphs', EXPORT_DIR: '/tmp/jatoba-stdio-exports' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined); child.stderr.on('data', () => undefined);
    let buffer = ''; const pending = new Map(); let nextId = 1;
    child.stdout.on('data', (chunk) => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const value = JSON.parse(line); pending.get(value.id)?.(value); } catch { /* transport noise is not a response */ } } });
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(new Error('stdio timeout')); }, 10000); pending.set(id, (value) => { clearTimeout(timer); pending.delete(id); resolve(value); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'load-check', version: '1' } }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const tools = [
      ['recall', { project: projectId, query: 'stdio stability', limit: 10 }],
      ['project_context', { project: projectId, max_items: 10 }],
      ['context_retrieve', { project: projectId, query: 'stdio stability', max_items: 10 }],
      ['metrics', { project: projectId }],
      ['project_timeline', { project: projectId, limit: 10 }],
    ];
    for (let i = 0; i < 500; i += 1) { const [name, args] = tools[i % tools.length]; const started = performance.now(); const result = await rpc('tools/call', { name, arguments: args }); report.calls += 1; report.latencies_ms.push(performance.now() - started); if (result.error || result.result?.isError) report.failures += 1; }
    child.stdin.end(); await new Promise((resolve) => { const timer = setTimeout(() => child.kill('SIGTERM'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    report.p50_ms = percentile(report.latencies_ms, .5); report.p95_ms = percentile(report.latencies_ms, .95); report.p99_ms = percentile(report.latencies_ms, .99); report.classification = report.failures === 0 && !child.exitCode ? 'PASS' : 'DEGRADED'; console.log(`STDIO_RESULT ${JSON.stringify(report)}`);
  } finally { await compose('down', '-v', '--remove-orphans').catch(() => undefined); }
}
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2)); }
await main().catch((error) => { console.error(`STDIO_FAILED ${error.stack ?? error.message}`); process.exitCode = 1; });
