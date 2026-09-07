# Security Model

## Threat model

O Brain trata memória de agentes, projetos e a chave administrativa como dados sensíveis. A fronteira pública deve ser um reverse proxy HTTPS; PostgreSQL, dumps e diretórios de trabalho não são interfaces públicas.

## Network

O Compose principal mantém PostgreSQL apenas na rede Docker interna e publica o Brain em `127.0.0.1` por padrão (`BRAIN_BIND_ADDRESS`). Caddy pode terminar TLS na borda e encaminhar para `brain:3338`. O exemplo local usa Caddy `tls internal`; isso não é certificado de produção.

`TRUST_PROXY_HOPS=0` é o default. Só configure um número maior quando um proxy controlado estiver imediatamente à frente do Brain. Assim, `X-Forwarded-For` e `X-Forwarded-Proto` não são aceitos cegamente da internet.

## Authentication and rate limits

API, MCP HTTP e dashboard exigem `BRAIN_API_KEY`; dashboard também aceita Basic Auth local com usuário `admin`. A comparação da chave usa `timingSafeEqual`. Rate limits separados protegem health, API/dashboard e MCP, incluindo chamadas autenticadas. Falhas de autenticação não revelam detalhes da chave.

## HTTP hardening

O app aplica CSP, `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` e `Cache-Control: no-store`. HSTS só é emitido quando `HSTS_ENABLED=true` e a requisição é HTTPS reconhecida através de proxy confiável. Body limit, request timeout, header timeout e keep-alive são configuráveis.

CORS fica desabilitado por padrão: dashboard e API devem usar same-origin. Se uma origem explícita for necessária, configure `CORS_ORIGINS` com uma lista separada por vírgulas; o sistema não usa `*`.

## Secrets and logs

`.env` real, tokens, Authorization headers, dumps, chaves e modelos não pertencem ao Git. Audit logs armazenam somente metadados allowlisted, nunca body, headers, exceptions brutas ou credenciais. Respostas de erro públicas são sanitizadas.

## Health

`/live` informa somente que o processo está vivo. `/ready` verifica dependências mínimas e `/health` expõe apenas estado operacional não secreto. Todos têm rate limit próprio.

## Database, Graphify and recovery

PostgreSQL permanece privado. Graphify só opera sobre repositories validados pelo path safety existente. Backups usam `pg_dump -Fc`, checksum e restore explicitamente descartável; consulte [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Known limitations

- Rate limit é local à instância e não substitui firewall, WAF ou limite distribuído.
- Caddy e certificados de produção ainda precisam ser configurados na VPS.
- Não há rotação automática de `BRAIN_API_KEY`.
- O dashboard continua sendo uma interface administrativa read-only, não um sistema completo de usuários.
