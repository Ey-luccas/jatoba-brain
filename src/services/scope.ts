import { db } from '../db.js';
import { resolveProject } from './project.service.js';

export type Scope = { project?: string; actor?: string; repositoryId?: string; scope?: 'project' | 'repository' | 'global' };
export function budget(value: number | undefined, fallback = 20, max = 100) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error('Budget must be a positive integer');
  return Math.min(value ?? fallback, max);
}
export async function resolveScope(input: Scope) {
  if (input.scope && !['project','repository','global'].includes(input.scope)) throw new Error('Invalid scope');
  if (input.scope === 'global') {
    if (input.repositoryId) throw new Error('Global scope cannot specify a repository');
    return { projectId: null, repositoryId: null };
  }
  const project = await resolveProject(input.project, input.actor);
  if (input.scope === 'repository' && !input.repositoryId) throw new Error('Repository scope requires repositoryId');
  if (input.repositoryId) {
    const repo = await db.query('SELECT id FROM repositories WHERE id=$1 AND project_id=$2', [input.repositoryId, project.id]);
    if (!repo.rowCount) throw new Error('Repository does not belong to project');
  }
  return { projectId: project.id as string, repositoryId: input.repositoryId ?? null };
}
