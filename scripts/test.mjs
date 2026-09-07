import { randomBytes } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const project='jatoba-test-'+randomBytes(5).toString('hex');
const dir=await mkdtemp(path.join(os.tmpdir(),'jatoba-tests-'));
const env={...process.env,JATOBA_TEST_PASSWORD:randomBytes(24).toString('hex'),JATOBA_TEST_API_KEY:randomBytes(32).toString('hex')};
const graphifyBin=process.env.GRAPHIFY_BIN??'graphify';
try { execFileSync(graphifyBin,['--help'],{stdio:'ignore'}); }
catch { console.error(`Graphify CLI 0.9.55 is required for integration tests. Set GRAPHIFY_BIN to an executable path, for example: GRAPHIFY_BIN=/tmp/jatoba-graphify-venv/bin/graphify npm test`); process.exit(1); }
const reservation=createServer();
await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
env.JATOBA_TEST_DB_PORT=String(reservation.address().port);
await new Promise(r=>reservation.close(r));
const args=['compose','-p',project,'-f','docker-compose.test.yml'];
const docker=(tail)=>execFileSync('docker',[...args,...tail],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  docker(['up','-d','--wait','postgres']);
  const port=docker(['port','postgres','5432']).split(':').at(-1);
  Object.assign(env,{DATABASE_URL:`postgresql://jatoba:${env.JATOBA_TEST_PASSWORD}@127.0.0.1:${port}/jatoba_test`,
    BRAIN_API_KEY:env.JATOBA_TEST_API_KEY,WORKSPACE_DIR:dir,GRAPH_DIR:path.join(dir,'graphs'),EXPORT_DIR:path.join(dir,'exports'),
    EMBEDDINGS_ENABLED:'false',TEST_COMPOSE_PROJECT:project,TEST_COMPOSE_FILE:path.resolve('docker-compose.test.yml')});
  const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1','tests/integration.test.ts'],{env,stdio:'inherit'});
  process.exitCode=result.status??1;
} catch {
  console.error('Integration environment failed. Verify Docker availability.');
  process.exitCode=1;
} finally {
  // Only this randomly named test project owns these disposable resources.
  try {docker(['down','--remove-orphans']); console.log('Preserved test volume: '+project+'_test_postgres');} catch {console.error('Could not clean isolated test project: '+project);}
  await rm(dir,{recursive:true,force:true});
}
