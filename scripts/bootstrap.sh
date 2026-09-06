#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  KEY="$(openssl rand -hex 32)"
  PASS="$(openssl rand -hex 24)"
  sed -i "s/troque-por-uma-chave-forte/$KEY/" .env
  sed -i "s/troque-esta-senha/$PASS/g" .env
  echo "Arquivo .env criado. Edite ALLOWED_HOSTS e troque SEU_IP_DA_VPS pelo IP real."
fi

docker compose up -d --build

echo "Jatobá iniciado. Teste: curl http://127.0.0.1:3338/health"
