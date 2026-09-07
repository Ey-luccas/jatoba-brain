import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath,['--check','dashboard/app.js'],{stdio:'inherit'});
const html=await readFile('dashboard/index.html','utf8');
for(const file of ['app.js','style.css']) {
  await readFile('dashboard/'+file);
  if(!html.includes('./'+file)) throw new Error('Missing dashboard asset: '+file);
}
console.log('Dashboard static assets validated (no bundle required).');
