import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const project=`jatoba-security-${randomBytes(5).toString('hex')}`;
const password=randomBytes(24).toString('hex');
const apiKey=randomBytes(32).toString('hex');
const env={...process.env,JATOBA_TEST_PASSWORD:password,JATOBA_TEST_API_KEY:apiKey};
function docker(...args) { return execFileSync('docker',['compose','-p',project,'-f','docker-compose.test.yml','-f','docker-compose.security.yml',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
function request(url,{method='GET',headers=[],body}={}) {
  const args=['-k','-sS','--max-time','10','-X',method];
  for(const header of headers) args.push('-H',header);
  if(body!==undefined) args.push('--data-binary',body);
  args.push('-D','-','-o','-','-w','\n__STATUS__%{http_code}',url);
  const raw=execFileSync('curl',args,{encoding:'utf8'});
  const marker=raw.lastIndexOf('\n__STATUS__');
  const status=Number(raw.slice(marker+11).trim());
  return {status,raw:raw.slice(0,marker)};
}
function assert(condition,message) { if(!condition) throw new Error(message); }
function waitFor(url) { for(let i=0;i<30;i+=1) { try { if(request(url).status===200) return; } catch {} execFileSync('sleep',['1']); } throw new Error(`endpoint not ready: ${url}`); }

try {
  docker('up','-d','--build','--wait');
  const brain=`http://127.0.0.1:${docker('port','brain','3338').split(':').at(-1)}`;
  const proxy=`https://localhost:${docker('port','proxy','8443').split(':').at(-1)}`;
  waitFor(`${brain}/live`); waitFor(`${proxy}/live`);
  const auth=`authorization: Bearer ${apiKey}`;
  assert(request(`${brain}/api/projects`).status===401,'unauthenticated API request was accepted');
  assert(request(`${brain}/api/projects`,{headers:['authorization: Bearer invalid']}).status===401,'invalid API key was accepted');
  execFileSync('sleep',['1']);
  const validApi=request(`${brain}/api/projects`,{headers:[auth]});
  assert(validApi.status===200,`valid API key was rejected with status ${validApi.status}: ${validApi.raw.slice(-160)}`);
  const headers=request(`${brain}/live`).raw;
  for(const required of ['content-security-policy:','x-content-type-options: nosniff','referrer-policy: no-referrer','permissions-policy:']) assert(headers.toLowerCase().includes(required),`missing security header: ${required}`);
  const oversized=JSON.stringify({project:'00000000-0000-0000-0000-000000000000',type:'GENERAL',content:'x'.repeat(5000)});
  assert(request(`${brain}/api/tools/remember`,{method:'POST',headers:[auth,'content-type: application/json'],body:oversized}).status===413,'oversized payload was not rejected');
  const error=request(`${brain}/api/tools/not-a-real-tool`,{method:'POST',headers:[auth,'content-type: application/json'],body:'{}'});
  assert(error.status===400 && !/DATABASE_URL|node_modules|\/app\//.test(error.raw),'internal error details leaked');
  const cors=request(`${brain}/api/projects`,{headers:[auth,'origin: https://evil.example']});
  assert(!cors.raw.toLowerCase().includes('access-control-allow-origin'),'unexpected permissive CORS header');
  execFileSync('sleep',['1']);
  assert(request(`${brain}/api/projects`,{headers:[auth]}).status===200,'rate-limit window did not reset');
  assert(request(`${brain}/api/projects`,{headers:[auth]}).status===200,'second limited request failed');
  assert(request(`${brain}/api/projects`,{headers:[auth]}).status===429,'API rate limit did not return 429');
  const dashboard=request(`${brain}/dashboard/`); assert(dashboard.status===401,'dashboard accepted no credentials');
  const basic=Buffer.from(`admin:${apiKey}`).toString('base64'); assert(request(`${brain}/dashboard/`,{headers:[`authorization: Basic ${basic}`]}).status===200,'dashboard auth failed');
  const init=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'security-test',version:'1'}}});
  assert(request(`${brain}/mcp`,{method:'POST',headers:[auth,'content-type: application/json','accept: application/json, text/event-stream'],body:init}).status===200,'authenticated MCP request failed');
  execFileSync('sleep',['1']);
  const proxyHealth=request(`${proxy}/live`); assert(proxyHealth.status===200,'HTTPS proxy liveness failed');
  assert(proxyHealth.raw.toLowerCase().includes('strict-transport-security:'),'HSTS was not emitted behind trusted HTTPS proxy');
  assert(request(`${proxy}/api/projects`).status===401,'HTTPS proxy bypassed authentication');
  console.log(JSON.stringify({auth:true,headers:true,body_limit:true,error_sanitization:true,cors:true,rate_limit:true,dashboard:true,mcp:true,tls_proxy:true},null,2));
} finally {
  try { docker('down','--remove-orphans'); } catch {}
}
