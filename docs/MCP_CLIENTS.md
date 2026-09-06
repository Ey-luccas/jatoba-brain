# Conectar clientes MCP

Endpoint local:

```text
http://127.0.0.1:3338/mcp
```

Endpoint VPS em testes:

```text
http://SEU_IP:3338/mcp
```

Produção:

```text
https://SEU_IP/mcp
```

Todos precisam enviar:

```text
Authorization: Bearer <BRAIN_API_KEY>
```

## Claude Code

Exemplo:

```bash
claude mcp add --transport http jatoba https://SEU_IP/mcp \
  --header "Authorization: Bearer SUA_CHAVE"
```

A configuração de projeto também pode usar variável de ambiente para não versionar segredo.

## Codex

No `~/.codex/config.toml`:

```toml
[mcp_servers.jatoba]
url = "https://SEU_IP/mcp"
bearer_token_env_var = "JATOBA_API_KEY"
enabled = true
```

Depois:

```bash
export JATOBA_API_KEY="SUA_CHAVE"
codex mcp list
```

O arquivo `config/codex-config.toml.example` contém um exemplo completo.

## Outros clientes

Qualquer cliente que suporte MCP Streamable HTTP pode apontar para `/mcp`. O servidor usa MCP TypeScript SDK v2 e o protocolo 2026-07-28, mantendo fallback stateless para clientes da era 2025 fornecido pelo SDK.

## Modo local stdio

Para um cliente que execute o Jatobá na mesma máquina, também há `dist/stdio.js`:

```bash
npm run build
npm run mcp:stdio
```

Veja `config/local-stdio-mcp.json.example`. Nesse modo não existe tráfego HTTP entre cliente e servidor MCP.

Se quiser usar somente o PostgreSQL do Docker e o MCP stdio no host:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres
export DATABASE_URL=postgresql://jatoba:SUA_SENHA@127.0.0.1:54329/jatoba
npm run build
npm run mcp:stdio
```
