import type { Express, Request, Response } from 'express';
import { createProject, listProjects, projectContext, addRepository } from './services/project.service.js';
import { remember, recall } from './services/memory.service.js';
import { exportDocuments } from './services/export.service.js';

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((error) => {
      console.error(error);
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    });
  };
}

export function registerRoutes(app: Express): void {
  app.get('/api/projects', asyncRoute(async (_req, res) => res.json(await listProjects())));

  app.post('/api/projects', asyncRoute(async (req, res) => {
    const project = await createProject(req.body);
    res.status(201).json(project);
  }));

  app.post('/api/projects/:project/repositories', asyncRoute(async (req, res) => {
    const repository = await addRepository({ project: req.params.project, ...req.body });
    res.status(201).json(repository);
  }));

  app.get('/api/projects/:project/context', asyncRoute(async (req, res) => {
    res.json(await projectContext(routeParam(req.params.project)));
  }));

  app.post('/api/memories', asyncRoute(async (req, res) => {
    res.status(201).json(await remember(req.body));
  }));

  app.post('/api/recall', asyncRoute(async (req, res) => {
    res.json(await recall(req.body));
  }));

  app.post('/api/projects/:project/export', asyncRoute(async (req, res) => {
    const exported = await exportDocuments(routeParam(req.params.project));
    res.json({ directory: exported.directory, files: exported.files });
  }));
}
