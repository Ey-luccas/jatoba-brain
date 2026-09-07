# Clientes MCP

O endpoint HTTP local é `http://127.0.0.1:3338/mcp`. Ele requer `Authorization: Bearer <BRAIN_API_KEY>` ou `X-Jatoba-Key`. Para produção, configure HTTPS antes de expor o serviço.

## HTTP e stdio

Clientes Streamable HTTP podem apontar para `/mcp`. Clientes locais também podem executar `npm run mcp:stdio`; nesse modo o processo exige as variáveis de banco, mas não há autenticação HTTP entre cliente e servidor.

Exemplos de configuração estão em [config/claude-mcp.json.example](../config/claude-mcp.json.example), [config/codex-config.toml.example](../config/codex-config.toml.example) e [config/local-stdio-mcp.json.example](../config/local-stdio-mcp.json.example).

## Tools MCP

O servidor registra 35 tools.

### Project / Repository

`project_create`, `project_list`, `project_select`, `repository_add`, `repository_list`, `project_context`

### Memory

`remember`, `recall`

### Tasks

`start_task`, `finish_task`

### Decisions / Errors / Solutions

`record_decision`, `record_error`, `record_solution`, `checkpoint`, `git_snapshot`

### Graph

`graph_index`, `graph_status`, `graph_query`, `graph_neighbors`, `graph_impact`

### Context and temporal graph

`relations_query`, `trace_relationships`, `project_timeline`, `repository_timeline`, `task_timeline`, `context_retrieve`

### Sessions / Agents

`session_start`, `session_note`, `session_finish`, `agent_register`, `task_assign`, `task_takeover`, `agent_handoff`

### Observability / Export

`metrics`, `export_docs`

## Escopo seguro

`recall` e `context_retrieve` usam escopo de projeto por padrão. Um repositório precisa pertencer ao projeto informado. Busca global exige `scope: "global"` explícito e não aceita `repositoryId`.

## Fluxo recomendado

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

Use `context_retrieve` para uma resposta limitada e rastreável quando memória semântica, estrutura e história operacional forem relevantes.
