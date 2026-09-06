#!/usr/bin/env bash
set -euo pipefail
if [ $# -lt 3 ]; then
  echo "Uso: $0 <base-url> <api-key> <nome-do-projeto> [slug]"
  exit 1
fi
BASE_URL="$1"
API_KEY="$2"
NAME="$3"
SLUG="${4:-}"
PAYLOAD="$(python3 - "$NAME" "$SLUG" <<'PY'
import json, sys
name, slug = sys.argv[1], sys.argv[2]
payload = {"name": name}
if slug:
    payload["slug"] = slug
print(json.dumps(payload))
PY
)"

curl -sS -X POST "$BASE_URL/api/projects" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
echo
