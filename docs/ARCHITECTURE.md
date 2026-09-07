# Arquitetura do Jatobá Brain

O Jatobá Brain mantém contexto operacional fora do modelo de IA. O banco é a fonte primária; documentos exportados e o dashboard são projeções desse estado.

## Princípios

1. Memória fora do modelo: nenhum agente é a fonte única da verdade.
2. Isolamento por projeto: registros operacionais carregam `project_id` e referências são validadas no banco.
3. Repositório é um recorte adicional: uma busca em `scope=repository` exige o `repositoryId` daquele projeto.
4. Global só quando explícito: `scope=global` nunca é escolhido por padrão.
5. Git é objetivo: o Jatobá associa fatos de trabalho ao estado Git quando há evidência fornecida.
6. Contexto é limitado: recuperação retorna blocos relevantes, não a conversa ou o grafo completo.

## Camadas de memória

```text
Semantic Memory: PostgreSQL + pgvector
  "O que é relevante?"
        |
Structural Memory: Graphify
  "Como o código está conectado?"
        |
Operational / Temporal Memory: Work Graph
  "O que aconteceu?"
        |
Hybrid Context Retriever
  "Qual contexto devemos entregar ao agente?"
        |
Multi-Agent Handoff
  "Quem continua o trabalho?"
        |
Observability
  "O que está acontecendo no Jatobá?"
```

## Hierarquia e isolamento

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

As migrations verificam referências de repositório, tarefa, sessão e erro no mesmo projeto. O serviço também resolve o escopo antes de consultar ou gravar dados. Isso impede que uma consulta de projeto ou repositório atravesse a fronteira sem `scope=global` explícito.

## Persistent Memory

Memórias recebem conteúdo, tipo, importância, metadados, vínculos opcionais com tarefa, sessão e agente, além de embedding opcional. Quando embeddings estão disponíveis, a recuperação combina similaridade vetorial, busca textual PostgreSQL, importância e recência. Sem embeddings válidos, a busca textual continua disponível.

## Structural Memory

O Graphify extrai explicitamente um grafo AST por repositório Git registrado. O metadado fica em `repository_graphs` com commit, estado, caminho e contagens. `READY` indica snapshot no commit atual; `STALE` indica que o commit mudou; `ERROR` preserva a disponibilidade do núcleo de memória. O grafo permanece no filesystem configurado e somente subgrafos limitados são retornados por MCP.

## Operational / Temporal Memory

`work_entities`, `memory_edges` e `work_events` modelam fatos operacionais no PostgreSQL. Triggers criam relações quando os dados existem:

```text
Agent --EXECUTED--> Task --CREATED--> Decision
Task --FOUND--> Error --RESOLVED_BY--> Solution
Task --CHANGED--> File
Task --PRODUCED--> Commit
Task --FINISHED_AT--> Checkpoint
```

Consultas de relações e timeline respeitam projeto e repositório. Percursos detectam ciclos e limitam profundidade entre 1 e 4.

## Hybrid Context Retriever

`context_retrieve` combina memória semântica, filtros estruturados, expansão limitada do grafo estrutural, relações e timeline operacional. O ranking usa relevância, importância e recência. Limites de itens, categorias, nós e profundidade fazem parte da entrada, e cada item retorna fontes como `MEMORY`, `TASK`, `DECISION`, `ERROR`, `CHECKPOINT`, `FILE` ou `COMMIT`.

## Sessões e handoff

Agentes possuem identidade configurável. Sessões registram escopo, estado e resumo; notas brutas não são promovidas automaticamente. A transferência de trabalho recupera tarefas, decisões, erros, soluções, mudanças, checkpoints e contexto recente. A atribuição usa bloqueio transacional e takeover requer sinalização explícita.

## Transportes e interface

- MCP HTTP em `/mcp`, protegido por Bearer ou `X-Jatoba-Key`.
- MCP stdio para clientes locais.
- API administrativa em `/api`.
- Dashboard técnico, autenticado e principalmente somente leitura em `/dashboard`.
- Healthcheck público em `/health`, sem credenciais.

## Observabilidade e exportação

As operações MCP são auditadas com tool, escopo, resultado, duração e quantidade de itens, sem argumentos, corpos de resultado, headers ou exceções brutas. Métricas são calculadas a partir de tabelas e auditoria. `export_docs` gera Markdown derivado do banco; esses arquivos não substituem a memória primária.

## Migrations

`src/migrate.ts` inicializa o schema base quando necessário e aplica `db/migrations` em ordem, com lock transacional, tabela `schema_migrations` e checksum. A repetição segura é responsabilidade do runner; scripts SQL individuais não devem ser reaplicados manualmente. Antes de atualizar um volume PostgreSQL existente, faça backup e valide a compatibilidade do layout.
