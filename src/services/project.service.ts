import { db } from '../db.js';
import { config } from '../config.js';
import { slugify } from '../utils.js';

export async function ensureWorkspace(slug = config.defaultWorkspace) {
  const normalized = slugify(slug) || config.defaultWorkspace;
  const existing = await db.query('SELECT * FROM workspaces WHERE slug = $1', [normalized]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await db.query(
    `INSERT INTO workspaces (name, slug) VALUES ($1, $2)
     RETURNING *`,
    [slug, normalized],
  );
  return created.rows[0];
}

export async function createProject(input: {
  name: string;
  slug?: string;
  description?: string;
  workspace?: string;
}) {
  const workspace = await ensureWorkspace(input.workspace);
  const slug = slugify(input.slug || input.name);
  const result = await db.query(
    `INSERT INTO projects (workspace_id, name, slug, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, slug)
     DO UPDATE SET name = EXCLUDED.name, description = COALESCE(EXCLUDED.description, projects.description), updated_at = NOW()
     RETURNING *`,
    [workspace.id, input.name, slug, input.description ?? null],
  );
  return result.rows[0];
}

export async function listProjects() {
  const result = await db.query(
    `SELECT p.*, w.slug AS workspace_slug
     FROM projects p
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.archived_at IS NULL
     ORDER BY p.updated_at DESC`,
  );
  return result.rows;
}

export async function getProject(project: string) {
  const base = `SELECT p.*, w.slug AS workspace_slug
                FROM projects p
                JOIN workspaces w ON w.id = p.workspace_id`;

  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(project)) {
    const byId = await db.query(`${base} WHERE p.id = $1::uuid`, [project]);
    if (!byId.rows[0]) throw new Error(`Project not found: ${project}`);
    return byId.rows[0];
  }

  if (project.includes('/')) {
    const [workspace, slug] = project.split('/', 2);
    const scoped = await db.query(`${base} WHERE w.slug = $1 AND p.slug = $2`, [workspace, slug]);
    if (!scoped.rows[0]) throw new Error(`Project not found: ${project}`);
    return scoped.rows[0];
  }

  const bySlug = await db.query(`${base} WHERE p.slug = $1 ORDER BY p.created_at`, [project]);
  if (bySlug.rowCount === 0) throw new Error(`Project not found: ${project}`);
  if ((bySlug.rowCount ?? 0) > 1) {
    throw new Error(`Ambiguous project slug: ${project}. Use workspace/project.`);
  }
  return bySlug.rows[0];
}

export async function addRepository(input: {
  project: string;
  name: string;
  slug?: string;
  path?: string;
  remoteUrl?: string;
  defaultBranch?: string;
}) {
  const project = await getProject(input.project);
  const slug = slugify(input.slug || input.name);
  const result = await db.query(
    `INSERT INTO repositories (project_id, name, slug, local_path, remote_url, default_branch)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, slug)
     DO UPDATE SET name = EXCLUDED.name,
                   local_path = COALESCE(EXCLUDED.local_path, repositories.local_path),
                   remote_url = COALESCE(EXCLUDED.remote_url, repositories.remote_url),
                   default_branch = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
                   updated_at = NOW()
     RETURNING *`,
    [project.id, input.name, slug, input.path ?? null, input.remoteUrl ?? null, input.defaultBranch ?? 'main'],
  );
  return result.rows[0];
}

export async function selectProject(actor: string, projectRef: string) {
  const project = await getProject(projectRef);
  const result = await db.query(
    `INSERT INTO actor_project_context (actor_key, project_id)
     VALUES ($1, $2)
     ON CONFLICT (actor_key)
     DO UPDATE SET project_id = EXCLUDED.project_id, selected_at = NOW()
     RETURNING *`,
    [actor, project.id],
  );
  return { ...result.rows[0], project };
}

export async function resolveProject(projectRef?: string, actor?: string) {
  if (projectRef) return getProject(projectRef);
  if (!actor) throw new Error('Provide project or actor with a selected project');
  const result = await db.query(
    `SELECT p.*, w.slug AS workspace_slug
     FROM actor_project_context c
     JOIN projects p ON p.id = c.project_id
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE c.actor_key = $1`,
    [actor],
  );
  if (!result.rows[0]) throw new Error(`No project selected for actor: ${actor}`);
  return result.rows[0];
}

export async function projectContext(projectRef: string, options: {
  repositoryId?: string; max_items?: number; max_tasks?: number; max_decisions?: number; max_errors?: number;
  include_structural?: boolean; query?: string;
} = {}) {
  const { resolveScope, budget } = await import('./scope.js');
  const project = await getProject(projectRef);
  const scope = await resolveScope({project: project.id,repositoryId: options.repositoryId});
  let remaining = budget(options.max_items,50,100);
  const definitions = [
    ['repositories','repositories',10,'created_at',10],
    ['recent_tasks','tasks',options.max_tasks ?? 10,'created_at DESC',20],
    ['decisions','decisions',options.max_decisions ?? 10,'created_at DESC',20],
    ['errors','errors',options.max_errors ?? 10,'created_at DESC',20],
    ['checkpoints','checkpoints',5,'created_at DESC',10],
    ['important_memories','memories',10,'importance DESC,created_at DESC',30],
  ] as const;
  const result: Record<string, any[]> = {};
  for (const [key,table,requested,order,max] of definitions) {
    const limit = Math.min(remaining,budget(requested,10,max));
    const fields = table === 'memories' ? 'id,project_id,repository_id,task_id,memory_type,title,content,importance,source,created_at' : '*';
    result[key] = limit ? (await db.query(`SELECT ${fields} FROM ${table} WHERE project_id=$1
      AND ($2::uuid IS NULL OR ${table === 'repositories' ? 'id' : 'repository_id'}=$2) ORDER BY ${order} LIMIT $3`,
      [project.id,scope.repositoryId,limit])).rows : [];
    remaining-=result[key].length;
  }
  const structural_context = options.include_structural && scope.repositoryId && remaining
    ? await (await import('./graph.service.js')).graphQuery({project:project.id,repositoryId:scope.repositoryId,
      query:options.query ?? '',max_nodes:Math.min(remaining,10),max_edges:10,depth:1}) : undefined;
  return {project,...result,structural_context} as {
    project: any; repositories: any[]; recent_tasks: any[]; decisions: any[]; errors: any[];
    checkpoints: any[]; important_memories: any[]; structural_context?: unknown;
  };
}
