# Deploy em VPS por IP

## Topologia

```text
Claude / Codex / outro MCP client
              │
              ▼
       IP_DA_VPS:3338
              │
        Jatobá Brain
              │
       rede Docker interna
              │
          PostgreSQL
          + pgvector
```

O PostgreSQL não possui `ports:` no Compose e não fica público.

## 1. Preparar a VPS

Instale Docker Engine e o plugin Docker Compose seguindo a documentação da distribuição. Depois:

```bash
git clone SEU_REPOSITORIO jatoba-brain
cd jatoba-brain
cp .env.example .env
```

Gere segredos:

```bash
openssl rand -hex 32
openssl rand -hex 24
```

Preencha:

```env
BRAIN_API_KEY=<primeiro segredo>
POSTGRES_PASSWORD=<segundo segredo>
DATABASE_URL=postgresql://jatoba:<segundo segredo>@postgres:5432/jatoba
ALLOWED_HOSTS=127.0.0.1,localhost,SEU_IP_PUBLICO
```

## 2. Subir

```bash
docker compose up -d --build
```

Ver logs:

```bash
docker compose logs -f brain
```

Teste local na VPS:

```bash
curl http://127.0.0.1:3338/health
```

Teste externo:

```bash
curl http://SEU_IP_PUBLICO:3338/health
```

## 3. Firewall

Abra `3338/tcp` somente se for realmente consumir o MCP diretamente por essa porta. Para produção, prefira publicar somente `443/tcp` por um proxy HTTPS.

## 4. Atualizar

```bash
git pull
docker compose up -d --build
```

O volume `jatoba_postgres` preserva o banco.

## 5. Backup

```bash
./scripts/backup.sh
```

Além do dump SQL, copie periodicamente `exports/` se quiser preservar os artefatos exportados.

## Segurança

Uma chave Bearer em `http://IP:3338` trafega sem criptografia. Use HTTP puro apenas em localhost, VPN ou rede confiável. Para internet pública, veja `HTTPS-IP.md`.
