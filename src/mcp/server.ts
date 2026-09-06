import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { asJsonText } from '../utils.js';
import { createProject, addRepository, listProjects, projectContext, selectProject } from '../services/project.service.js';
import { remember, recall } from '../services/memory.service.js';
import { createCheckpoint, finishTask, recordDecision, recordError, startTask } from '../services/task.service.js';
import { exportDocuments } from '../services/export.service.js';
import { gitSnapshot } from '../services/git.service.js';
import { finishSession, sessionNote, startSession } from '../services/session.service.js';

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: asJsonText(value) }],
  structuredContent: { data: value },
});

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'jatoba-brain', version: '0.1.0' },
    {
      instructions: [
        'Jatobá Brain é a memória persistente do projeto.',
        'Selecione um projeto por actor antes de trabalhar, ou informe project em cada ferramenta.',
        'Registre decisões arquiteturais e erros relevantes.',
        'Ao concluir trabalho, use finish_task e checkpoint quando houver um estado estável.',
        'Use recall antes de decisões que possam repetir trabalho anterior.',
      ].join(' '),
    },
  );

  server.registerTool('project_create', {
    description: 'Cria ou atualiza um projeto isolado no Jatobá Brain.',
    inputSchema: z.object({
      name: z.string().min(1),
      slug: z.string().optional(),
      description: z.string().optional(),
      workspace: z.string().optional(),
    }),
  }, async (input) => textResult(await createProject(input)));

  server.registerTool('project_list', {
    description: 'Lista projetos disponíveis.',
  }, async () => textResult(await listProjects()));

  server.registerTool('project_select', {
    description: 'Seleciona o projeto ativo para um actor/agente. Evita misturar memória entre projetos.',
    inputSchema: z.object({ actor: z.string().min(1), project: z.string().min(1) }),
  }, async ({ actor, project }) => textResult(await selectProject(actor, project)));

  server.registerTool('repository_add', {
    description: 'Registra um repositório/subprojeto dentro de um projeto.',
    inputSchema: z.object({
      project: z.string(), name: z.string(), slug: z.string().optional(), path: z.string().optional(),
      remoteUrl: z.string().optional(), defaultBranch: z.string().optional(),
    }),
  }, async (input) => textResult(await addRepository(input)));

  server.registerTool('session_start', {
    description: 'Inicia uma sessão opcional de trabalho/chat dentro de um projeto.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), agentKey: z.string().optional(),
      title: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => textResult(await startSession(input)));

  server.registerTool('session_note', {
    description: 'Registra uma mensagem/nota de sessão. Use apenas quando o histórico bruto realmente for útil.',
    inputSchema: z.object({
      sessionId: z.string().uuid(), role: z.enum(['user','assistant','system','tool','agent']),
      content: z.string(), metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => textResult(await sessionNote(input)));

  server.registerTool('session_finish', {
    description: 'Finaliza a sessão e opcionalmente promove seu resumo a uma memória persistente.',
    inputSchema: z.object({
      sessionId: z.string().uuid(), summary: z.string(), promoteToMemory: z.boolean().optional(),
      importance: z.number().int().min(1).max(10).optional(), tags: z.array(z.string()).optional(),
    }),
  }, async (input) => textResult(await finishSession(input)));

  server.registerTool('start_task', {
    description: 'Abre uma tarefa e registra qual agente está trabalhando nela.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), repositoryId: z.string().uuid().optional(),
      agentKey: z.string(), title: z.string(), description: z.string().optional(), priority: z.number().int().min(1).max(10).optional(),
      parentTaskId: z.string().uuid().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => textResult(await startTask(input)));

  server.registerTool('finish_task', {
    description: 'Finaliza uma tarefa e registra resumo, arquivos, commit, testes, decisões e pendências.',
    inputSchema: z.object({
      taskId: z.string().uuid(),
      status: z.enum(['completed', 'failed', 'blocked', 'cancelled']).optional(),
      summary: z.string(),
      filesChanged: z.array(z.object({ path: z.string(), action: z.string().optional() })).optional(),
      commitHash: z.string().optional(), branch: z.string().optional(),
      tests: z.record(z.string(), z.unknown()).optional(),
      decisions: z.array(z.string()).optional(), pending: z.array(z.string()).optional(),
      inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => textResult(await finishTask(input)));

  server.registerTool('remember', {
    description: 'Guarda uma memória semântica ligada ao projeto atual.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), repositoryId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(), agentKey: z.string().optional(), type: z.string(), title: z.string().optional(),
      content: z.string(), importance: z.number().int().min(1).max(10).optional(), tags: z.array(z.string()).optional(),
      source: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => textResult(await remember(input)));

  server.registerTool('recall', {
    description: 'Recupera somente as memórias relevantes. O padrão pesquisa apenas o projeto atual; global é explícito.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), query: z.string(),
      limit: z.number().int().min(1).max(30).optional(), scope: z.enum(['project', 'global']).optional(),
    }),
  }, async (input) => textResult(await recall(input)));

  server.registerTool('record_decision', {
    description: 'Registra uma decisão de arquitetura/produto como ADR estruturado.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), repositoryId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(), agentKey: z.string().optional(), title: z.string(), decision: z.string(),
      reason: z.string().optional(), consequences: z.string().optional(), status: z.string().optional(),
    }),
  }, async (input) => textResult(await recordDecision(input)));

  server.registerTool('record_error', {
    description: 'Registra problema, causa e solução para evitar repetir erros no futuro.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), repositoryId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(), agentKey: z.string().optional(), title: z.string(), error: z.string(),
      cause: z.string().optional(), solution: z.string().optional(), status: z.string().optional(),
    }),
  }, async (input) => textResult(await recordError(input)));

  server.registerTool('checkpoint', {
    description: 'Registra um ponto estável do projeto com commit, testes e resumo.',
    inputSchema: z.object({
      project: z.string().optional(), actor: z.string().optional(), repositoryId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(), agentKey: z.string().optional(), title: z.string(), summary: z.string(),
      commitHash: z.string().optional(), branch: z.string().optional(), tests: z.record(z.string(), z.unknown()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => textResult(await createCheckpoint(input)));

  server.registerTool('project_context', {
    description: 'Retorna contexto compacto do projeto: repositórios, tarefas, decisões, erros, checkpoints e memórias importantes.',
    inputSchema: z.object({ project: z.string() }),
  }, async ({ project }) => textResult(await projectContext(project)));

  server.registerTool('git_snapshot', {
    description: 'Captura estado objetivo de um repositório montado em WORKSPACE_DIR sem usar tokens de IA.',
    inputSchema: z.object({ repositoryPath: z.string().min(1) }),
  }, async ({ repositoryPath }) => textResult(await gitSnapshot(repositoryPath)));

  server.registerTool('export_docs', {
    description: 'Converte a memória estruturada do projeto em documentos Markdown e HANDOFF.',
    inputSchema: z.object({ project: z.string() }),
  }, async ({ project }) => {
    const result = await exportDocuments(project);
    return textResult({ directory: result.directory, files: result.files });
  });

  return server;
}
