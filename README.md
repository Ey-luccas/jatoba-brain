<p align="center">
  <img src="./capa-logo.png" alt="Jatobá Brain" width="100%">
</p>

<h1 align="center">Jatobá Brain</h1>

<p align="center">
  Memória persistente multi-projeto para agentes de IA via MCP.
</p>

<p align="center"><em>Memória que constrói o amanhã.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20 ou superior">
  <img src="https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/pgvector-enabled-336791" alt="pgvector">
  <img src="https://img.shields.io/badge/Docker-validated-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/MCP-compatible-111827" alt="MCP">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="Licença MIT">
</p>

O Jatobá Brain é uma camada de memória persistente para agentes de IA. Ele registra contexto operacional de projetos fora do modelo e o disponibiliza por MCP, HTTP e stdio.

Claude hoje. Codex amanhã. Outro modelo depois.

A memória pertence ao projeto, não a um modelo específico.

## O que está implementado

- memória persistente isolada por workspace, projeto e repositório;
- PostgreSQL, pgvector opcional e fallback textual;
- tarefas, decisões, erros, soluções, checkpoints, sessões e mudanças Git;
- grafo estrutural por repositório com Graphify;
- Work Graph temporal para relações e timeline;
- recuperação híbrida limitada, rastreável e resiliente a fallbacks;
- handoff entre agentes e ownership transacional de tarefas;
- métricas, audit log, exportação de documentos e dashboard técnico;
- MCP Streamable HTTP autenticado e MCP stdio local.

## Arquitetura

```text
Agente MCP
    |
    v
Jatobá Brain
    |
    +-- Semantic Memory: PostgreSQL + pgvector
    |     "O que é relevante?"
    |
    +-- Structural Memory: Graphify
    |     "Como o código está conectado?"
    |
    +-- Operational / Temporal Memory: Work Graph
    |     "O que aconteceu?"
    |
    +-- Hybrid Context Retriever
    |     "Qual contexto devemos entregar ao agente?"
    |
    +-- Multi-Agent Handoff
    |     "Quem continua o trabalho?"
    |
    +-- Observability + Dashboard
          "O que está acontecendo no Jatobá?"
```

A hierarquia de isolamento é:

```text
WORKSPACE
  └── PROJECT
      └── REPOSITORY
          ├── TASK
          ├── MEMORY
          ├── DECISION
          ├── ERROR / SOLUTION
          ├── CHANGE / COMMIT
          ├── CHECKPOINT
          └── SESSION
```

Por padrão, recuperação usa o projeto selecionado. Busca entre projetos só ocorre com `scope: "global"` explícito. Um `repositoryId` é validado contra o projeto.

Veja [a arquitetura detalhada](docs/ARCHITECTURE.md), [a integração Graphify](docs/GRAPHIFY.md) e [a documentação de clientes MCP](docs/MCP_CLIENTS.md).

## Memória e contexto

### Persistent Memory

`remember` persiste memórias com tipo, conteúdo, importância, metadados e vínculos opcionais com tarefa, sessão, repositório e agente. `recall` combina busca textual PostgreSQL, similaridade vetorial quando disponível, importância e recência.

Embeddings são opcionais. Se o endpoint estiver indisponível ou retornar vetor inválido, a memória continua consultável pela busca textual.

### Structural Memory

`graph_index` gera explicitamente um snapshot Graphify para um repositório Git registrado. O Jatobá associa o snapshot ao commit usado na extração e informa `READY`, `STALE`, `INDEXING` ou `ERROR`.

O grafo fica separado por projeto/repositório e só subgrafos limitados são retornados. O `graph.json` inteiro nunca é enviado ao agente. Uma falha do Graphify não derruba o Memory Core.

### Operational / Temporal Memory

O Work Graph no PostgreSQL registra entidades, relações e eventos cronológicos. Relações automáticas incluem:

```text
Agent --EXECUTED--> Task --CREATED--> Decision
Task --FOUND--> Error --RESOLVED_BY--> Solution
Task --CHANGED--> File
Task --PRODUCED--> Commit
Task --FINISHED_AT--> Checkpoint
```

`relations_query`, `trace_relationships` e as tools de timeline respeitam o escopo selecionado. Trace detecta ciclos e aceita profundidade de 1 a 4.

### Hybrid GraphRAG

`context_retrieve` pode combinar:

1. memória semântica;
2. filtros estruturados para tarefas, decisões e erros;
3. contexto estrutural do Graphify;
4. relações e timeline do Work Graph;
5. importância e recência.

A entrada permite orçamento de itens, memórias, tarefas, decisões, erros, nós e profundidade. A resposta deduplica entidades e informa fontes como `MEMORY`, `TASK`, `DECISION`, `ERROR`, `CHECKPOINT`, `FILE` e `COMMIT`.

## Multi-Agent Handoff

Agentes são registrados com identidade independente do provedor. Uma sessão armazena estado e resumo, sem promover notas brutas automaticamente. `agent_handoff` reúne tarefas, decisões, erros, soluções, arquivos, commits e checkpoint relevantes para quem continua.

`task_assign` usa bloqueio transacional. Quando a tarefa já está em andamento por outro agente, o takeover exige `force_takeover: true` e fica registrado como relação operacional.

## Observability e Dashboard

O dashboard em `/dashboard` é administrativo, autenticado, técnico e principalmente somente leitura. Ele mostra overview, projetos, repositórios, agentes, sessões, tarefas, memórias, decisões, erros, checkpoints, timeline, relações, métricas e auditoria. Ainda não é uma interface de produto final.

As operações MCP são auditadas com tool, escopo, status, duração e quantidade de itens. Argumentos, corpos de resultado, headers, tokens e exceções brutas não entram no audit log.

`export_docs` gera documentos Markdown derivados da memória. A fonte de verdade continua sendo o banco.

## MCP tools

O servidor registra **35 tools**. A lista categorizada e os nomes exatos estão em [docs/MCP_CLIENTS.md](docs/MCP_CLIENTS.md).

Fluxo sugerido:

```text
project_select
project_context
recall
session_start
start_task
record_decision / record_error / record_solution
git_snapshot
finish_task
checkpoint
session_finish
agent_handoff
```

## Uso local

### Pré-requisitos

- Docker Engine com Docker Compose;
- Git;
- Node.js 20 ou superior para execução no host;
- uma chave administrativa local para `BRAIN_API_KEY`.

Crie o ambiente local sem versionar segredos:

```bash
cp .env.example .env
# Edite .env e substitua todos os CHANGE_ME.
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3338/health
```

O MCP HTTP fica em `http://127.0.0.1:3338/mcp`. API, MCP e dashboard exigem `BRAIN_API_KEY`; o healthcheck é público e não expõe credenciais.

### MCP stdio

Para clientes que executam o Jatobá localmente:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres
npm install
npm run build
npm run mcp:stdio
```

Use [config/local-stdio-mcp.json.example](config/local-stdio-mcp.json.example) e configure `DATABASE_URL` localmente. Exemplos para Claude e Codex estão em [config/claude-mcp.json.example](config/claude-mcp.json.example) e [config/codex-config.toml.example](config/codex-config.toml.example).

## Validação local

A implementação foi validada localmente com PostgreSQL, pgvector, Graphify, Docker e os transportes MCP reais.

- 27 cenários integration/release passando;
- build TypeScript e typecheck aprovados;
- Compose, build Docker e runtime aprovados;
- persistência confirmada após restart;
- Graphify real, isolamento de projeto/repositório, Work Graph, Hybrid GraphRAG, handoff, dashboard autenticado e observabilidade exercitados.

A qualidade semântica foi validada estruturalmente com embeddings determinísticos de teste. Uma avaliação de relevância com modelo de embeddings real ainda está pendente.

Execute a validação:

```bash
npm run build
npm run typecheck
# Os cenários estruturais exigem Graphify CLI 0.9.55 acessível em GRAPHIFY_BIN.
GRAPHIFY_BIN=graphify npm test
npm run test:release
docker compose config
```

## Roadmap

### v0.1 — Persistent Memory

- [X] PostgreSQL
- [X] pgvector
- [X] MCP
- [X] Projects
- [X] Repositories
- [X] Tasks
- [X] Decisions
- [X] Errors/Solutions
- [X] Checkpoints
- [X] Text fallback

### v0.2 — Structural Memory

- [X] Graphify integration
- [X] Repository knowledge graph
- [X] READY/STALE graph state
- [X] Dependency/impact queries

### v0.3 — Temporal Work Graph

- [X] Agent → Task
- [X] Task → Decision
- [X] Task → File
- [X] Error → Solution
- [X] Commit/Checkpoint relationships
- [X] Project timeline

### v0.4 — Hybrid GraphRAG

- [X] Semantic + graph retrieval
- [X] Hybrid ranking
- [X] Context budgeting
- [X] Traceability
- [X] Fallbacks

### v0.5 — Multi-Agent Handoff

- [X] Sessions
- [X] Agent handoff
- [X] Task ownership
- [X] Explicit takeover
- [X] Cross-agent continuation

### v0.6 — Observability

- [X] Metrics
- [X] Audit logs
- [X] Dashboard
- [X] Timeline visualization
- [X] Automatic document export

## Current limitations

- A qualidade semântica ainda precisa ser avaliada com um modelo de embeddings real.
- A autenticação usa uma chave administrativa compartilhada.
- Algumas métricas representam estado atual, não counters históricos imutáveis.
- Graphify ainda precisa de política de retenção para snapshots antigos.
- Upgrade de PostgreSQL existente exige backup e análise prévia.
- Testes de carga ainda não foram realizados.
- Operação prolongada de produção não foi validada.
- HTTPS ainda não foi configurado.

## Segurança

Nunca versione `.env`, chaves, tokens, backups, `node_modules`, `dist` ou dados de volumes. O [.gitignore](.gitignore) cobre esses caminhos e [.env.example](.env.example) contém somente placeholders.

Antes de expor o serviço, use uma chave longa, restrinja `ALLOWED_HOSTS`, configure HTTPS e valide backup/restauração do PostgreSQL.

## Licença

MIT. Consulte [LICENSE](LICENSE).
