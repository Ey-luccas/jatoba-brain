# 🌳 Jatobá Brain

**Memória persistente, multi-projeto e independente de modelo para agentes de IA via MCP.**

Jatobá Brain mantém o contexto operacional de projetos de software sem depender do histórico inteiro de uma conversa. Claude, Codex, Gemini, Cursor e outros clientes MCP podem compartilhar tarefas, decisões, erros, checkpoints e memórias relevantes sem misturar projetos.

## Descrição curta para o repositório

> Memória persistente multi-projeto para agentes de IA via MCP, com PostgreSQL, pgvector, Git, Graphify e exportação automática de documentação.

## O problema que resolve

Agentes de IA perdem contexto quando a sessão cresce, muda de modelo ou é reiniciada. O Jatobá guarda a memória fora do modelo e entrega apenas o contexto necessário para a tarefa atual.

```text
Workspace
  └── Project
      ├── Repository
      │   ├── Task
      │   ├── Decision
      │   ├── Error / Solution
      │   ├── Checkpoint
      │   └── Memory
      └── Documentation
```

Por padrão, a busca é isolada por projeto. Busca global precisa ser solicitada explicitamente.

## Arquitetura

```text
                    Usuário / Orquestrador
                             │
            ┌────────────────┼────────────────┐
            │                │                │
          Claude           Codex            Gemini
            │                │                │
            └────────────────┼────────────────┘
                             │ MCP
                       ┌─────▼─────┐
                       │  Jatobá   │
                       │   Brain   │
                       └─────┬─────┘
                             │
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
          PostgreSQL      pgvector        Git
               │                           │
               │                      estado real
               │
               └──────────────┐
                              ▼
                          Graphify
                      grafo do código
```

- **PostgreSQL:** histórico estruturado e fonte da memória persistente.
- **pgvector:** recuperação semântica opcional.
- **Git:** estado objetivo do código, commits, arquivos e diffs.
- **Graphify:** relações estruturais do código e consultas por grafo.
- **MCP:** interface comum para qualquer agente compatível.

## 6 papéis de agente incluídos

| Key | Papel | Responsabilidade |
|---|---|---|
| `maestro` | Orquestrador | Divide tarefas e consolida resultados |
| `backend` | Backend | APIs, banco e integrações |
| `frontend` | Frontend/Mobile | Flutter, web e UI |
| `testes` | QA | Testes e regressões |
| `revisor` | Reviewer | Arquitetura, segurança e qualidade |
| `escriba` | Memória/Docs | Decisões, handoffs e documentação |

Os papéis são sugestões, não dependências. Qualquer modelo pode atuar em qualquer papel.

## Ferramentas MCP

O servidor expõe inicialmente:

- `project_create`
- `project_list`
- `project_select`
- `repository_add`
- `session_start` / `session_note` / `session_finish` (opcional)
- `start_task`
- `finish_task`
- `remember`
- `recall`
- `record_decision`
- `record_error`
- `checkpoint`
- `project_context`
- `git_snapshot`
- `export_docs`

### Fluxo recomendado de um agente

```text
1. project_select
2. project_context
3. recall
4. start_task
5. trabalhar no código
6. finish_task
7. record_decision / record_error (quando necessário)
8. checkpoint (quando houver estado estável)
9. session_finish (se uma sessão de chat tiver sido aberta)
```

## Transportes MCP

O mesmo núcleo funciona de duas formas:

```text
Local:  cliente → stdio → Jatobá → PostgreSQL
Remoto: cliente → Streamable HTTP → Jatobá VPS → PostgreSQL
```

Isso evita prender o projeto à VPS: em uma máquina local use `npm run mcp:stdio`; em uma VPS use `/mcp` por HTTP/HTTPS.

## Começar localmente

### Requisitos

- Docker + Docker Compose
- Git
- Opcional: Graphify
- Opcional: servidor local de embeddings OpenAI-compatible

```bash
cp .env.example .env
```

Edite pelo menos:

```env
BRAIN_API_KEY=uma-chave-grande
POSTGRES_PASSWORD=uma-senha-grande
ALLOWED_HOSTS=127.0.0.1,localhost
```

Depois:

```bash
./scripts/bootstrap.sh
```

Teste:

```bash
curl http://127.0.0.1:3338/health
```

Endpoint MCP:

```text
http://127.0.0.1:3338/mcp
```

## Rodar na VPS usando o IP

No `.env`:

```env
HOST=0.0.0.0
PORT=3338
ALLOWED_HOSTS=127.0.0.1,localhost,203.0.113.10
```

Substitua `203.0.113.10` pelo IP real da VPS.

Depois:

```bash
docker compose up -d --build
```

Endpoint:

```text
http://203.0.113.10:3338/mcp
```

> Para tráfego pela internet, não envie a chave Bearer por HTTP puro. Use HTTPS no IP ou limite o acesso à rede privada. Veja `docs/VPS.md` e `docs/HTTPS-IP.md`.

## Autenticação

Todas as rotas `/api/*` e `/mcp` exigem:

```http
Authorization: Bearer SUA_CHAVE
```

ou:

```http
X-Jatoba-Key: SUA_CHAVE
```

O PostgreSQL não é publicado na internet pelo `docker-compose.yml`.

## Exemplo: criar projeto

```bash
curl -X POST http://127.0.0.1:3338/api/projects \
  -H "Authorization: Bearer SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Achei",
    "slug": "achei",
    "description": "Marketplace local de profissionais e empresas"
  }'
```

Adicionar repositório:

```bash
curl -X POST http://127.0.0.1:3338/api/projects/achei/repositories \
  -H "Authorization: Bearer SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Achei Backend",
    "slug": "backend",
    "remoteUrl": "git@example.com:achei/backend.git"
  }'
```

## Memória sem embeddings pagos

Por padrão:

```env
EMBEDDINGS_ENABLED=false
```

O `recall` usa full-text search no PostgreSQL. Nenhuma chamada extra de IA é necessária.

Para busca semântica, aponte para qualquer endpoint OpenAI-compatible de embeddings:

```env
EMBEDDINGS_ENABLED=true
EMBEDDINGS_API_URL=http://host.docker.internal:11434/v1/embeddings
EMBEDDINGS_MODEL=nomic-embed-text
```

O campo PostgreSQL é `vector` sem dimensionalidade fixa, permitindo trocar o modelo de embeddings. Para grandes volumes, crie um índice vetorial específico depois de fixar um modelo/dimensão.

## Graphify

O Graphify fica separado do banco de memória porque resolve outra pergunta: **como o código está conectado?**

No repositório que será mapeado:

```bash
uv tool install graphifyy
graphify install
```

Dentro do assistente compatível:

```text
/graphify .
```

Depois o grafo pode ser compartilhado por HTTP:

```bash
python -m graphify.serve graphify-out/graph.json --transport http --port 8080
```

Veja `docs/GRAPHIFY.md`.

## Exportar memória em documentação

Via MCP:

```text
export_docs(project="achei")
```

ou API:

```bash
curl -X POST http://127.0.0.1:3338/api/projects/achei/export \
  -H "Authorization: Bearer SUA_CHAVE"
```

O Jatobá gera:

```text
exports/achei/<timestamp>/
├── PROJECT.md
├── DECISIONS.md
├── ERRORS-AND-SOLUTIONS.md
├── TIMELINE.md
├── MEMORIES.md
└── HANDOFF.md
```

A memória permanece estruturada no banco; os documentos são uma visão humana exportável dela.

## Backup

```bash
./scripts/backup.sh
```

O dump é salvo em `backups/`.

## Estado desta versão

`v0.1.0` é um MVP de infraestrutura funcional. As próximas evoluções planejadas incluem:

- OAuth/identidade por cliente MCP;
- painel web para visualizar memórias;
- resumo automático de sessões;
- exportação DOCX/PDF;
- auditoria e quotas por workspace;
- worker de embeddings assíncrono;
- integração automática com hooks Git/CI;
- roteador multi-Graphify por projeto.

## Licença

MIT.
