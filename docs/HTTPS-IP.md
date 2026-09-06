# HTTPS sem domínio: certificado para o IP

Desde 2026, a Let's Encrypt disponibiliza certificados públicos para endereços IP. Eles usam o perfil de curta duração e exigem renovação frequente.

## Requisitos

- IP público estável;
- portas 80/443 alcançáveis;
- Certbot recente (5.4+ é recomendado para o fluxo webroot com IP);
- proxy reverso (Nginx/Caddy/Apache) na frente do Jatobá.

Exemplo de solicitação com Certbot, conforme a documentação da Let's Encrypt:

```bash
sudo certbot certonly \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/certbot \
  --ip-address SEU_IP_PUBLICO
```

Depois configure o proxy para encaminhar:

```text
https://SEU_IP_PUBLICO/mcp
               ↓
http://127.0.0.1:3338/mcp
```

E automatize a renovação:

```bash
sudo certbot renew
```

> O método exato de proxy/certbot depende da distribuição e do webserver. Não exponha o Bearer token em HTTP pela internet.
