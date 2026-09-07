import express from 'express';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { authGuard,hostGuard,dashboardGuard } from './middleware/auth.js';
import { buildMcpServer } from './mcp/server.js';
import { registerRoutes } from './routes.js';
import { health } from './services/observability.service.js';
import { dashboardData } from './services/dashboard.service.js';
import { resolveProject } from './services/project.service.js';

export function createApp() {
  const app=express();
  app.disable('x-powered-by');
  app.use(express.json({limit:'2mb'}));
  app.use(hostGuard);
  app.use((_req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    next();
  });
  app.get('/health',async(_req,res)=>{const result=await health();res.status(result.ok?200:503).json(result);});
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
  app.all('/mcp',authGuard,(req,res)=>{void nodeHandler(req,res,req.body);});
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    res.status(400).json({error:'invalid_request'});
  });
  return {app,close:()=>handler.close()};
}
