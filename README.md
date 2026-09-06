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
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/MCP-compatible-111827" alt="MCP">
  <img src="https://img.shields.io/badge/Git-integrated-F05032?logo=git&logoColor=white" alt="Git">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="Licença MIT"></a>
</p>

O Jatobá Brain é uma camada de memória persistente para agentes de IA. Ele registra o contexto operacional de projetos de software fora do modelo e o disponibiliza por meio do Model Context Protocol (MCP).

Claude hoje. Codex amanhã. Outro modelo depois.

A memória continua sendo do projeto, não de um modelo específico.

## O que ele resolve

Agentes de IA perdem contexto entre sessões, trocas de modelo e reinícios. Em projetos grandes, isso pode causar:

- repetição de trabalho;
- decisões esquecidas;
- bugs reintroduzidos;
- consumo desnecessário de tokens;
- dificuldade para outro agente continuar o trabalho.

O Jatobá cria uma memória externa e persistente para que agentes compatíveis com MCP possam:

- lembrar o que já foi feito;
- registrar tarefas e sessões;
- registrar decisões, erros e soluções;
- criar checkpoints;
- consultar contexto anterior;
- separar memória por projeto;
- trabalhar com vários repositórios;
- gerar documentação a partir da memória estruturada.

## A ideia em uma frase

> O Jatobá não tenta substituir o agente. Ele ajuda o agente a continuar de onde o projeto parou.

## Arquitetura

```text
                         Usuário
                            │
                            ▼
                 Claude / Codex / Gemini
                            │
                            ▼
                     Jatobá Brain
                         (MCP)
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        PostgreSQL       pgvector      Graphify
        histórico e      busca         relações do
        memória          semântica     código
              │                           │
              └─────────────┬─────────────┘
                            ▼
                            Git
                     estado real do código
```

- **MCP:** interface usada pelos agentes para consultar e registrar contexto.
- **PostgreSQL:** histórico estruturado, projetos, tarefas, decisões, erros e memórias.
- **pgvector:** armazenamento e recuperação semântica opcional por embeddings.
- **Graphify:** relações estruturais do código; não substitui o banco de memória.
- **Git:** fonte objetiva das alterações, commits, branches e arquivos modificados.

Para os princípios e limites da arquitetura, consulte [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Memória organizada por projeto

O contexto segue uma hierarquia explícita:

```text
Workspace
  └── Project
      └── Repository
          ├── Task
          ├── Memory
          ├── Decision
          ├── Error
          ├── Change
          └── Checkpoint
```

Um workspace pode reunir vários projetos e cada projeto pode conter vários repositórios:

```text
Lucas Labs
├── Achei
│   ├── achei-backend
│   └── achei-app
└── Mundo Mãe
    ├── backend
    └── frontend
```

Por padrão, a recuperação é isolada no projeto atual:

```text
scope: project
```

Uma busca entre projetos precisa ser explícita:

```text
scope: global
```

Isso reduz o risco de misturar decisões, tarefas ou soluções de produtos diferentes.

## Como funciona

```text
1. O agente seleciona o projeto.
2. Recupera somente a memória relevante.
3. Inicia uma tarefa.
4. Trabalha no código e consulta o Git.
5. Registra decisões, erros e contexto útil.
6. Finaliza a tarefa com arquivos, testes e pendências.
7. Cria um checkpoint quando o projeto chega a um estado estável.
8. A próxima sessão recupera o contexto necessário.
```

O Jatobá não envia a conversa inteira, a documentação inteira ou o projeto inteiro para o modelo. A proposta é recuperar blocos pequenos e relevantes, como o estado do projeto, decisões importantes, memórias relacionadas e a tarefa atual.

## Ferramentas MCP

O servidor MCP registra as seguintes ferramentas no código atual:

| Tool | Função |
|---|---|
| `project_create` | Cria ou atualiza um projeto isolado. |
| `project_list` | Lista os projetos disponíveis. |
| `project_select` | Seleciona o projeto ativo para um agente. |
| `repository_add` | Registra um repositório dentro de um projeto. |
| `session_start` | Inicia uma sessão opcional de trabalho. |
| `session_note` | Registra uma nota de sessão quando o histórico bruto for útil. |
| `session_finish` | Finaliza a sessão e pode promover seu resumo a memória. |
| `start_task` | Abre uma tarefa e registra o agente responsável. |
| `finish_task` | Finaliza uma tarefa com resumo, arquivos, commit, testes e pendências. |
| `remember` | Guarda uma memória semântica ligada ao projeto. |
| `recall` | Recupera memórias relevantes por projeto ou, explicitamente, de forma global. |
| `record_decision` | Registra uma decisão de arquitetura ou produto. |
| `record_error` | Registra problema, causa e solução. |
| `checkpoint` | Registra um ponto estável com resumo, commit e testes. |
| `project_context` | Retorna um contexto compacto do projeto. |
| `git_snapshot` | Captura o estado objetivo de um repositório Git montado. |
| `export_docs` | Converte a memória estruturada em documentos Markdown. |

Fluxo recomendado:

```text
project_select
project_context
recall
start_task
trabalho no código
record_decision / record_error
finish_task
checkpoint
```

As ferramentas de sessão (`session_start`, `session_note` e `session_finish`) são opcionais e devem ser usadas quando preservar o histórico da conversa trouxer valor.

## Papéis de agente

Os seis papéis iniciais são carregados por `config/agents.json`:

| Key | Nome | Responsabilidade |
|---|---|---|
| `maestro` | Maestro | Divide objetivos em tarefas, escolhe agentes, recupera contexto e consolida resultados. |
| `backend` | Construtor Backend | Implementa APIs, banco de dados, integrações e serviços. |
| `frontend` | Construtor Interface | Implementa frontend, Flutter/mobile e interfaces de usuário. |
| `testes` | Sentinela de Testes | Cria e executa testes, valida regressões e registra falhas. |
| `revisor` | Revisor | Revisa arquitetura, segurança, qualidade e impacto das mudanças. |
| `escriba` | Escriba | Consolida decisões, checkpoints, handoffs e documentação derivada da memória. |

Os papéis são convenções de colaboração. Qualquer modelo compatível pode atuar em qualquer papel.

## Stack

- Node.js 20 ou superior;
- TypeScript;
- Express;
- PostgreSQL;
- pgvector, habilitado no schema inicial;
- MCP TypeScript SDK;
- Docker e Docker Compose;
- Git;
- Graphify como ferramenta complementar para relações do código.

## Quick Start

### Pré-requisitos

- Docker Engine e Docker Compose;
- Git;
- Node.js 20 ou superior, caso queira executar o modo stdio no host;
- OpenSSL, usado pelo script opcional de bootstrap para gerar segredos.

Clone o projeto e crie o arquivo local de ambiente:

```bash
git clone https://github.com/Ey-luccas/jatoba-brain.git
cd jatoba-brain
cp .env.example .env
```

Edite `.env` e substitua todos os placeholders por valores locais. O arquivo `.env` não deve ser versionado.

Para uma execução local, os valores essenciais seguem este formato:

```env
BRAIN_API_KEY=CHANGE_ME
POSTGRES_PASSWORD=CHANGE_ME
DATABASE_URL=postgresql://jatoba:CHANGE_ME@postgres:5432/jatoba
ALLOWED_HOSTS=127.0.0.1,localhost
```

Suba o PostgreSQL e o Jatobá:

```bash
docker compose up -d --build
docker compose ps
```

Verifique a saúde do serviço:

```bash
curl http://localhost:3338/health
```

A rota `/health` consulta o banco e retorna o status do serviço. O endpoint MCP HTTP fica em:

```text
http://localhost:3338/mcp
```

O script `scripts/bootstrap.sh` também pode ser usado como atalho para preparar o ambiente e executar o Compose. Para produção ou VPS, revise os placeholders e as regras de acesso antes de usá-lo.

## Uso local

### MCP local via stdio

No modo stdio, o cliente executa o servidor MCP localmente. O tráfego MCP não passa por HTTP.

Primeiro, publique somente o PostgreSQL na interface local:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres
```

Depois, instale as dependências, compile e inicie o servidor:

```bash
npm install
npm run build
npm run mcp:stdio
```

O arquivo [config/local-stdio-mcp.json.example](config/local-stdio-mcp.json.example) mostra a configuração do cliente. Ele usa a porta local `54329` para o PostgreSQL e deve receber a senha configurada no seu `.env`.

### MCP remoto via HTTP

Com o Compose em execução, clientes compatíveis com MCP Streamable HTTP podem apontar para `/mcp`. As rotas `/api/*` e `/mcp` exigem autenticação por Bearer ou pelo cabeçalho alternativo `X-Jatoba-Key`.

Exemplo para Claude Code:

```bash
claude mcp add --transport http jatoba https://SEU_IP/mcp \\
  --header "Authorization: Bearer SUA_CHAVE"
```

Exemplo para Codex em `~/.codex/config.toml`:

```toml
[mcp_servers.jatoba]
url = "https://SEU_IP/mcp"
bearer_token_env_var = "JATOBA_API_KEY"
enabled = true
```

Depois, mantenha a chave fora do repositório:

```bash
export JATOBA_API_KEY="SUA_CHAVE"
codex mcp list
```

Veja também [config/claude-mcp.json.example](config/claude-mcp.json.example), [config/codex-config.toml.example](config/codex-config.toml.example) e [docs/MCP_CLIENTS.md](docs/MCP_CLIENTS.md).

## API HTTP

As rotas HTTP autenticadas disponíveis atualmente são:

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/api/projects` | Lista projetos. |
| `POST` | `/api/projects` | Cria ou atualiza um projeto. |
| `POST` | `/api/projects/:project/repositories` | Adiciona um repositório ao projeto. |
| `GET` | `/api/projects/:project/context` | Recupera o contexto compacto do projeto. |
| `POST` | `/api/memories` | Registra uma memória. |
| `POST` | `/api/recall` | Consulta memórias relevantes. |
| `POST` | `/api/projects/:project/export` | Exporta a documentação do projeto. |

Exemplo de criação de projeto:

```bash
curl -X POST http://127.0.0.1:3338/api/projects \\
  -H "Authorization: Bearer SUA_CHAVE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Meu Projeto",
    "slug": "meu-projeto",
    "description": "Projeto integrado ao Jatobá Brain"
  }'
```

O endpoint `/health` é público para permitir a verificação do serviço; as rotas `/api/*` e `/mcp` exigem autenticação.

## Exemplo de fluxo

Imagine que o usuário peça:

> Implemente refresh token.

Um fluxo de trabalho possível é:

```text
1. project_select(project="meu-projeto", actor="backend")
2. recall(project="meu-projeto", query="refresh token")
3. start_task(agentKey="backend", title="Implementar refresh token")
4. O agente altera o código e valida os testes.
5. record_decision(...) para registrar a estratégia escolhida.
6. finish_task(...) com arquivos, testes e pendências.
7. checkpoint(...) quando o estado estiver estável.
```

Em uma nova sessão, `recall(query="refresh token")` pode recuperar a decisão, os arquivos alterados, a tarefa anterior e as pendências relevantes. Os parâmetros acima são ilustrativos; os schemas completos estão no servidor MCP.

## Menos contexto, mais relevância

Em vez de enviar para o modelo:

- a conversa inteira;
- toda a documentação;
- o projeto inteiro;

o Jatobá pode recuperar:

- o resumo do projeto;
- decisões importantes;
- memórias relacionadas à consulta;
- o repositório relevante;
- a tarefa atual e seus checkpoints.

O `recall` usa busca textual no PostgreSQL por padrão. Se `EMBEDDINGS_ENABLED=true` e um endpoint compatível estiver configurado, a recuperação semântica também pode ser usada.

### Configuração de embeddings

Embeddings são opcionais. Para permanecer sem chamadas externas, mantenha:

```env
EMBEDDINGS_ENABLED=false
```

Para usar um endpoint OpenAI-compatible, configure:

```env
EMBEDDINGS_ENABLED=true
EMBEDDINGS_API_URL=http://host.docker.internal:11434/v1/embeddings
EMBEDDINGS_API_KEY=CHANGE_ME
EMBEDDINGS_MODEL=nomic-embed-text
```

## Memória que vira documentação

As memórias estruturadas podem ser exportadas por `export_docs` ou pela API. A exportação atual gera:

```text
exports/<projeto>/<timestamp>/
├── PROJECT.md
├── DECISIONS.md
├── ERRORS-AND-SOLUTIONS.md
├── TIMELINE.md
├── MEMORIES.md
└── HANDOFF.md
```

A documentação não é a memória principal. Ela é uma representação humana derivada dos registros estruturados no PostgreSQL.

## Graphify, PostgreSQL e Git

Os componentes respondem a perguntas diferentes:

```text
Jatobá / PostgreSQL → o que aconteceu e por quê?
Graphify             → como o código está conectado?
Git                  → qual é o código real agora?
```

O Graphify fica separado do banco de memória. Para criar e compartilhar um grafo, consulte [docs/GRAPHIFY.md](docs/GRAPHIFY.md):

```bash
uv tool install graphifyy
graphify install
```

Dentro de um assistente compatível:

```text
/graphify .
```

Depois, o grafo pode ser servido por HTTP:

```bash
python -m graphify.serve graphify-out/graph.json --transport http --port 8080
```

## Executar em uma VPS

Para um ambiente remoto, configure o host e limite os hosts aceitos:

```env
HOST=0.0.0.0
PORT=3338
ALLOWED_HOSTS=127.0.0.1,localhost,SEU_IP_PUBLICO
```

Suba os serviços com:

```bash
docker compose up -d --build
```

O endpoint MCP será `https://SEU_IP/mcp` quando houver um proxy HTTPS configurado. Não transporte uma chave Bearer por HTTP público sem TLS. Consulte [docs/VPS.md](docs/VPS.md) e [docs/HTTPS-IP.md](docs/HTTPS-IP.md).

## Backup

O script de backup gera um dump SQL do PostgreSQL:

```bash
./scripts/backup.sh
```

Os dumps são salvos em `backups/`. Se os artefatos exportados também forem importantes, preserve o diretório `exports/`.

## Status do projeto

### Disponível nesta versão

- [x] Servidor MCP por HTTP e stdio;
- [x] PostgreSQL com schema inicial e extensão pgvector;
- [x] Isolamento por projeto e escopo global explícito;
- [x] Workspaces, projetos e múltiplos repositórios;
- [x] Sessões e tarefas;
- [x] Memórias com busca textual e embeddings opcionais;
- [x] Decisões, erros, soluções e checkpoints;
- [x] Captura objetiva de estado Git com `git_snapshot`;
- [x] Exportação de memória para Markdown;
- [x] Autenticação por chave para API e MCP.

### Ainda não disponível

- [ ] Dashboard web;
- [ ] Identidade e autenticação multiusuário;
- [ ] Observabilidade avançada;
- [ ] Exportação DOCX/PDF;
- [ ] Worker assíncrono dedicado para embeddings;
- [ ] Roteamento multi-Graphify por projeto.

## Roadmap

### v0.1

- memória persistente;
- MCP;
- workspaces e projetos;
- tarefas, sessões e checkpoints;
- decisões, erros e memórias;
- integração objetiva com Git;
- exportação de documentação Markdown;
- busca semântica opcional por embeddings.

### Futuro

- dashboard para visualizar memória e estado dos projetos;
- métricas e observabilidade;
- GraphRAG mais avançado;
- colaboração entre pessoas e agentes;
- gerenciamento visual de agentes;
- identidade e permissões por usuário ou cliente MCP.

O roadmap não representa funcionalidades disponíveis nem promete datas.

## Segurança

- Nunca versione `.env`, tokens, senhas ou chaves de API.
- Mantenha credenciais em variáveis de ambiente e use `.env.example` apenas como referência.
- O PostgreSQL não é publicado pelo Compose principal; publique-o somente na interface local quando necessário.
- Em ambiente remoto, use HTTPS antes de transportar uma chave Bearer.
- Restrinja `ALLOWED_HOSTS` e o acesso ao endpoint MCP.
- Não exponha endpoints autenticados diretamente à internet sem revisar firewall, proxy e TLS.

Para o procedimento de VPS e os cuidados de exposição por IP, consulte [docs/VPS.md](docs/VPS.md) e [docs/HTTPS-IP.md](docs/HTTPS-IP.md).

## Contribuindo

1. Faça um fork do projeto.
2. Crie uma branch para sua alteração.
3. Faça a mudança acompanhada de documentação ou testes quando necessário.
4. Rode `npm run build`.
5. Abra um Pull Request descrevendo o contexto e a validação realizada.

## Licença

Distribuído sob a [licença MIT](LICENSE).

Desenvolvido no Brasil 🇧🇷
