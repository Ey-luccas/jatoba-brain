import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

process.on('SIGPIPE', () => undefined);

const exec = promisify(execFile);
const project = `jatoba-graph-${process.pid}-${Date.now()}`;
const password = `graph-pass-${randomUUID()}`;
const apiKey = `graph-key-${randomUUID()}`;
const env = { ...process.env, JATOBA_TEST_PASSWORD: password, JATOBA_TEST_API_KEY: apiKey, GRAPHIFY_BIN: 'graphify', RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '100000', RATE_LIMIT_MCP_MAX: '100000' };
const compose = (...args) => exec('docker', ['compose', '-p', project, '-f', 'docker-compose.test.yml', ...args], { env, maxBuffer: 10 * 1024 * 1024 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2)); };

async function call(port, tool, input) {
  return new Promise((resolve) => {
    const start = performance.now();
    const body = JSON.stringify(input);
    const req = request({ hostname: '127.0.0.1', port, path: `/api/tools/${tool}`, method: 'POST', timeout: 10000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-jatoba-key': apiKey } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; } resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body: parsed, ms: performance.now() - start }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (error) => resolve({ ok: false, status: 0, error: error.message, ms: performance.now() - start }));
    req.end(body);
  });
}

async function validateFixture(root) {
  const files = (await readdir(root)).filter((name) => name.endsWith('.ts'));
  const modules = new Set(files);
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const imported of source.matchAll(/from ['"]\.\/(module-\d+\.ts)['"]/g)) assert.ok(modules.has(imported[1]), `missing fixture import target: ${imported[1]}`);
  }
  const tsc = path.resolve('node_modules/.bin/tsc');
  await exec(tsc, ['--noEmit', '--allowImportingTsExtensions', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...files], { cwd: root, maxBuffer: 2_000_000 });
  return { files: files.length, broken_imports: 0, missing_symbols: 0 };
}

async function main() {
  let tempRoot;
  const report = { generated_at: new Date().toISOString(), indexing: [], query_load: [], concurrent_index: null, cross_repo_concurrency: null, stale: null, hybrid: null, medium_fixture_validation: null, relations: null, classification: 'FAIL' };
  try {
    await compose('up', '-d', '--build');
    const port = Number((await compose('port', 'brain', '3338')).stdout.trim().split(':').pop());
    for (let i = 0; i < 60; i += 1) { if ((await call(port, 'project_list', {})).ok) break; await sleep(500); }

    tempRoot = await mkdtemp('/tmp/jatoba-graph-check-');
    const smallFixture = path.join(tempRoot, 'small');
    await mkdir(smallFixture, { recursive: true });
    await writeFile(path.join(smallFixture, 'auth.ts'), 'export class AuthService { session() { return true } }\nexport class SessionStore { auth() { return new AuthService().session() } }\n');
    await exec('git', ['init', '-q'], { cwd: smallFixture });
    await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: smallFixture });
    await exec('git', ['config', 'user.name', 'GraphTest'], { cwd: smallFixture });
    await exec('git', ['add', '.'], { cwd: smallFixture });
    await exec('git', ['commit', '-qm', 'fixture'], { cwd: smallFixture });
    await exec('docker', ['cp', `${smallFixture}/.`, `${project}-brain-1:/workspace/graph-small`]);

    const created = await call(port, 'project_create', { name: 'Graph Project', slug: `graph-${process.pid}`, workspace: 'graph-workspace' });
    const projectId = created.body.id;
    const repo = await call(port, 'repository_add', { project: projectId, name: 'Graph Small', path: 'graph-small' });
    const base = { project: projectId, repositoryId: repo.body.id };

    const mediumFixture = path.join(tempRoot, 'medium');
    await mkdir(mediumFixture, { recursive: true });
    await Promise.all(Array.from({ length: 180 }, (_, i) => {
      const next = (i + 1) % 180;
      return writeFile(path.join(mediumFixture, `module-${i}.ts`), `import { Module${next} } from './module-${next}.ts';\nexport function module${i}Name() { return 'module-${i}'; }\nexport class Module${i} { run() { return new Module${next}().run(); } }\n`);
    }));
    report.medium_fixture_validation = await validateFixture(mediumFixture);
    await exec('git', ['init', '-q'], { cwd: mediumFixture });
    await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: mediumFixture });
    await exec('git', ['config', 'user.name', 'GraphTest'], { cwd: mediumFixture });
    await exec('git', ['add', '.'], { cwd: mediumFixture });
    await exec('git', ['commit', '-qm', 'medium fixture'], { cwd: mediumFixture });
    await exec('docker', ['cp', `${mediumFixture}/.`, `${project}-brain-1:/workspace/graph-medium`]);
    const mediumRepo = await call(port, 'repository_add', { project: projectId, name: 'Graph Medium', path: 'graph-medium' });
    const mediumBase = { project: projectId, repositoryId: mediumRepo.body.id };

    const indexStart = performance.now();
    const indexed = await call(port, 'graph_index', base);
    report.indexing.push({ size: 'small', files: 1, ms: Number((performance.now() - indexStart).toFixed(2)), status: indexed.body?.status, http_status: indexed.status, nodes: indexed.body?.nodes_count ?? null, edges: indexed.body?.edges_count ?? null, bytes: indexed.body?.graph_path ? (await exec('docker', ['exec', `${project}-brain-1`, 'stat', '-c', '%s', indexed.body.graph_path])).stdout.trim() : null });
    const mediumStart = performance.now();
    const indexedMedium = await call(port, 'graph_index', mediumBase);
    report.indexing.push({ size: 'medium', files: 180, ms: Number((performance.now() - mediumStart).toFixed(2)), status: indexedMedium.body?.status, http_status: indexedMedium.status, nodes: indexedMedium.body?.nodes_count ?? null, edges: indexedMedium.body?.edges_count ?? null, bytes: indexedMedium.body?.graph_path ? (await exec('docker', ['exec', `${project}-brain-1`, 'stat', '-c', '%s', indexedMedium.body.graph_path])).stdout.trim() : null });
    assert.equal(indexedMedium.body?.status, 'READY', 'medium graph must be READY before queries');

    const queryRuns = [];
    for (const concurrency of [1, 5, 10, 25]) {
      const results = [];
      let next = 0;
      const started = performance.now();
      const worker = async () => { while (true) { const i = next++; if (i >= 40) return; results.push(await call(port, ['graph_query', 'graph_neighbors', 'graph_impact'][i % 3], { ...mediumBase, query: 'Module0', entity: 'Module0', depth: 1, max_nodes: 20, max_edges: 30 })); } };
      await Promise.all(Array.from({ length: concurrency }, worker));
      const elapsed = (performance.now() - started) / 1000;
      const errors = results.filter((result) => !result.ok).length;
      queryRuns.push({ concurrency, operations: results.length, errors, error_rate: Number((errors / results.length).toFixed(4)), p50_ms: percentile(results.map((result) => result.ms), .5), p95_ms: percentile(results.map((result) => result.ms), .95), p99_ms: percentile(results.map((result) => result.ms), .99), rps: Number((results.length / elapsed).toFixed(2)) });
    }
    report.query_load = queryRuns;

    const concurrent = await Promise.all([call(port, 'graph_index', base), call(port, 'graph_index', base)]);
    report.concurrent_index = concurrent.map((result) => result.body.status);
    const crossRepo = await Promise.all([call(port, 'graph_index', base), call(port, 'graph_index', mediumBase)]);
    report.cross_repo_concurrency = crossRepo.map((result) => result.body.status);

    const mediumRelations = await Promise.all([
      call(port, 'graph_query', { ...mediumBase, query: 'Module0', depth: 1, max_nodes: 20, max_edges: 30 }),
      call(port, 'graph_neighbors', { ...mediumBase, entity: 'Module0', depth: 1, max_nodes: 20, max_edges: 30 }),
      call(port, 'graph_impact', { ...mediumBase, entity: 'Module0', depth: 1, max_nodes: 20, max_edges: 30 }),
    ]);
    report.relations = { query: mediumRelations[0].ok && mediumRelations[0].body?.nodes?.some((node) => node.label.includes('Module0')), neighbors: mediumRelations[1].ok && mediumRelations[1].body?.edges?.length > 0, impact: mediumRelations[2].ok && mediumRelations[2].body?.edges?.length > 0, passed: mediumRelations.filter((result) => result.ok).length };

    await exec('docker', ['exec', `${project}-brain-1`, 'sh', '-c', "printf '\nexport class NewDependency {}\n' >> /workspace/graph-small/auth.ts"]);
    const stale = await call(port, 'graph_status', base);
    report.stale = { ready: (await call(port, 'graph_status', mediumBase)).body.status, after_change: stale.body.status };
    await exec('docker', ['exec', `${project}-brain-1`, 'sh', '-c', 'cd /workspace/graph-small && git -c safe.directory=/workspace/graph-small add auth.ts && git -c safe.directory=/workspace/graph-small commit -qm update']);
    report.stale.after_reindex = (await call(port, 'graph_index', base)).body.status;

    await call(port, 'remember', { project: projectId, repositoryId: mediumBase.repositoryId, type: 'FACT', content: 'Module0 session graph fixture context' });
    const hybrid = await call(port, 'context_retrieve', { project: projectId, repositoryId: mediumBase.repositoryId, query: 'Module0 session', max_items: 10, include_structural_graph: true, include_work_graph: false, include_timeline: false });
    const sourceRefs = hybrid.body?.sources?.map((source) => source.ref) ?? [];
    report.hybrid = { ok: hybrid.ok, budget: (hybrid.body?.memories?.length ?? 0) + (hybrid.body?.structural_context?.length ?? 0) <= 10, sources: sourceRefs, has_memory: sourceRefs.some((ref) => ref.startsWith('MEMORY')), has_file: sourceRefs.some((ref) => ref.startsWith('FILE')), has_graph_edge: sourceRefs.some((ref) => ref.startsWith('GRAPH_EDGE')) };
    report.classification = indexed.body?.status === 'READY' && indexedMedium.body?.status === 'READY' && report.relations?.passed === 3 && report.query_load.every((result) => result.errors === 0) && report.cross_repo_concurrency?.every((status) => status === 'READY') && report.hybrid.ok && report.hybrid.budget ? 'PASS' : 'DEGRADED';
    console.log(`GRAPH_RESULT ${JSON.stringify(report)}`);
  } finally {
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main().catch((error) => { console.error(`GRAPH_FAILED ${error.stack ?? error.message}`); process.exitCode = 1; });
