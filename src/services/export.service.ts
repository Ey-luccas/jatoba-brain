import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { getProject, projectContext } from './project.service.js';

function section(title: string, body: string): string {
  return `# ${title}\n\n${body.trim()}\n`;
}

function lines(items: any[], render: (item: any) => string): string {
  return items.length ? items.map(render).join('\n\n') : '_Nenhum registro._';
}

export async function buildDocuments(projectRef: string): Promise<Record<string, string>> {
  const ctx = await projectContext(projectRef);
  const project = ctx.project;
  const taskRows = await db.query(
    `SELECT t.*, r.slug AS repository_slug FROM tasks t
     LEFT JOIN repositories r ON r.id=t.repository_id
     WHERE t.project_id=$1 ORDER BY t.created_at DESC`, [project.id],
  );
  const decisions = await db.query(
    `SELECT d.*, r.slug AS repository_slug FROM decisions d
     LEFT JOIN repositories r ON r.id=d.repository_id
     WHERE d.project_id=$1 ORDER BY d.created_at`, [project.id],
  );
  const errors = await db.query(
    `SELECT e.*, r.slug AS repository_slug FROM errors e
     LEFT JOIN repositories r ON r.id=e.repository_id
     WHERE e.project_id=$1 ORDER BY e.created_at`, [project.id],
  );
  const memories = await db.query(
    `SELECT memory_type, title, content, importance, tags, source, created_at
     FROM memories WHERE project_id=$1 ORDER BY importance DESC, created_at DESC`, [project.id],
  );
  const checkpoints = await db.query(
    `SELECT * FROM checkpoints WHERE project_id=$1 ORDER BY created_at DESC`, [project.id],
  );

  const projectMd = section(project.name, [
    project.description ?? 'Sem descrição.',
    `**Slug:** \`${project.slug}\``,
    `**Workspace:** \`${project.workspace_slug}\``,
    `**Status:** ${project.status}`,
    '',
    '## Repositórios',
    lines(ctx.repositories, (r) => `- **${r.name}** (\`${r.slug}\`) — branch \`${r.default_branch}\`${r.remote_url ? ` — ${r.remote_url}` : ''}`),
  ].join('\n'));

  const decisionsMd = section('Decisões de Arquitetura', lines(decisions.rows, (d) => [
    `## ${d.title}`,
    `- Data: ${new Date(d.created_at).toISOString()}`,
    d.repository_slug ? `- Repositório: \`${d.repository_slug}\`` : '',
    `- Status: ${d.status}`,
    '',
    `**Decisão**\n\n${d.decision}`,
    d.reason ? `\n**Motivo**\n\n${d.reason}` : '',
    d.consequences ? `\n**Consequências**\n\n${d.consequences}` : '',
  ].filter(Boolean).join('\n')));

  const errorsMd = section('Erros e Soluções', lines(errors.rows, (e) => [
    `## ${e.title}`,
    `- Data: ${new Date(e.created_at).toISOString()}`,
    `- Status: ${e.status}`,
    '',
    `**Erro**\n\n${e.error_text}`,
    e.cause ? `\n**Causa**\n\n${e.cause}` : '',
    e.solution ? `\n**Solução**\n\n${e.solution}` : '',
  ].filter(Boolean).join('\n')));

  const timelineMd = section('Timeline de Tarefas', lines(taskRows.rows, (t) => [
    `## ${t.title}`,
    `- Status: ${t.status}`,
    `- Agente: ${t.agent_key}`,
    t.repository_slug ? `- Repositório: \`${t.repository_slug}\`` : '',
    `- Criada: ${new Date(t.created_at).toISOString()}`,
    t.summary ? `\n${t.summary}` : '',
  ].filter(Boolean).join('\n')));

  const memoriesMd = section('Memórias Consolidadas', lines(memories.rows, (m) => [
    `## ${m.title ?? m.memory_type}`,
    `- Tipo: ${m.memory_type}`,
    `- Importância: ${m.importance}/10`,
    `- Origem: ${m.source}`,
    m.tags?.length ? `- Tags: ${m.tags.join(', ')}` : '',
    '',
    m.content,
  ].filter(Boolean).join('\n')));

  const latestCheckpoint = checkpoints.rows[0];
  const activeTasks = taskRows.rows.filter((t: { status?: string }) => ['running', 'blocked', 'pending'].includes(t.status ?? '')).slice(0, 10);
  const handoffMd = section(`Handoff — ${project.name}`, [
    `**Projeto:** ${project.name} (\`${project.slug}\`)`,
    `**Gerado:** ${new Date().toISOString()}`,
    '',
    '## Estado atual',
    project.description ?? 'Sem descrição.',
    '',
    '## Último checkpoint',
    latestCheckpoint ? `**${latestCheckpoint.title}**\n\n${latestCheckpoint.summary}\n\nCommit: \`${latestCheckpoint.commit_hash ?? 'não informado'}\`` : '_Nenhum checkpoint._',
    '',
    '## Tarefas abertas',
    lines(activeTasks, (t) => `- [${t.status}] **${t.title}** — agente: ${t.agent_key}`),
    '',
    '## Decisões recentes',
    lines(decisions.rows.slice(-10).reverse(), (d) => `- **${d.title}:** ${d.decision}`),
    '',
    '## Problemas conhecidos',
    lines(errors.rows.filter((e: { status?: string }) => e.status !== 'resolved').slice(-10).reverse(), (e) => `- **${e.title}:** ${e.error_text}`),
    '',
    '## Repositórios',
    lines(ctx.repositories, (r) => `- \`${r.slug}\`${r.remote_url ? ` — ${r.remote_url}` : ''}`),
  ].join('\n'));

  return {
    'PROJECT.md': projectMd,
    'DECISIONS.md': decisionsMd,
    'ERRORS-AND-SOLUTIONS.md': errorsMd,
    'TIMELINE.md': timelineMd,
    'MEMORIES.md': memoriesMd,
    'HANDOFF.md': handoffMd,
  };
}

export async function exportDocuments(projectRef: string) {
  const project = await getProject(projectRef);
  const docs = await buildDocuments(project.slug);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(config.exportDir, project.slug, stamp);
  await mkdir(dir, { recursive: true });
  await Promise.all(Object.entries(docs).map(([name, content]) => writeFile(path.join(dir, name), content, 'utf8')));

  await db.query(
    `INSERT INTO documents (project_id, kind, title, content_md, metadata)
     VALUES ($1,'bundle',$2,$3,$4)`,
    [project.id, `Documentation bundle ${stamp}`, docs['HANDOFF.md'], { directory: dir, files: Object.keys(docs) }],
  );

  return { directory: dir, files: Object.keys(docs), documents: docs };
}
