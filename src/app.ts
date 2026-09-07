import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { authGuard,hostGuard,dashboardGuard } from './middleware/auth.js';
import { corsGuard,rateLimit,securityHeaders } from './middleware/security.js';
import { buildMcpServer } from './mcp/server.js';
import { registerRoutes } from './routes.js';
import { health } from './services/observability.service.js';
import { dashboardData } from './services/dashboard.service.js';
import { resolveProject } from './services/project.service.js';

export function createApp() {
  const app=express();
  app.disable('x-powered-by');
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use(express.json({limit:config.http.bodyLimit}));
  app.use(hostGuard);
  app.use(corsGuard);
  app.use(securityHeaders);
  app.get('/live',rateLimit('health'),(_req,res)=>res.json({ok:true,service:'jatoba-brain'}));
  app.get('/ready',rateLimit('health'),async(_req,res)=>{const result=await health();res.status(result.ok?200:503).json({ok:result.ok,service:'jatoba-brain',database:result.database,pgvector:result.pgvector});});
  app.get('/health',rateLimit('health'),async(_req,res)=>{const result=await health();res.status(result.ok?200:503).json({ok:result.ok,service:'jatoba-brain',database:result.database,pgvector:result.pgvector,graphify:result.graphify,uptime_seconds:result.uptime_seconds});});
  app.use('/api',rateLimit('api'));
  app.use('/dashboard',dashboardGuard,express.static(fileURLToPath(new URL('../dashboard/',import.meta.url))));
  app.get('/api/dashboard/:view',dashboardGuard,async(req,res)=>{
    try {
      const str=(v:unknown)=>typeof v==='string'?v:undefined;
      const input={project:str(req.query.project),repositoryId:str(req.query.repositoryId),query:str(req.query.query),type:str(req.query.type)};
      if(req.params.view!=='projects' && !input.project) throw new Error('Project is required');
      if(input.project) await resolveProject(input.project);
      res.json(await dashboardData(str(req.params.view)??'',input));
    } catch {res.status(400).json({error:'invalid_request'});}
  });
  app.use('/api',authGuard);
  registerRoutes(app);
  const handler=createMcpHandler(buildMcpServer);
  const nodeHandler=toNodeHandler(handler);
  app.all('/mcp',rateLimit('mcp'),authGuard,(req,res)=>{void nodeHandler(req,res,req.body);});
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const status=typeof error==='object'&&error!==null&&'status' in error&&Number((error as {status?:unknown}).status)===413?413:400;
    res.status(status).json({error:status===413?'payload_too_large':'invalid_request'});
  });
  return {app,close:()=>handler.close()};
}
