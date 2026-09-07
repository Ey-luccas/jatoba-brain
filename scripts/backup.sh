#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
ENV_FILE="${BACKUP_ENV_FILE:-.env}"
COMPOSE_FILE_PATH="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-}"
BACKUP_ROOT="${BACKUP_DIR:-backups}"

[[ -f "$ENV_FILE" ]] || { echo "Environment file not found: $ENV_FILE" >&2; exit 1; }
set -a
source "$ENV_FILE"
set +a
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

compose=(docker compose)
[[ -n "$COMPOSE_PROJECT" ]] && compose+=(-p "$COMPOSE_PROJECT")
compose+=(-f "$COMPOSE_FILE_PATH")
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
destination="$BACKUP_ROOT/$(date -u +%Y-%m-%d)"
dump="$destination/jatoba-$stamp.dump"
mkdir -p "$destination"

JATOBA_ENV_FILE="$ENV_FILE" "${compose[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$dump"
[[ -s "$dump" ]] || { echo "Backup dump is empty: $dump" >&2; exit 1; }

checksum="$dump.sha256"
(cd "$(dirname "$dump")" && sha256sum "$(basename "$dump")") > "$checksum"
size="$(stat -c '%s' "$dump")"
postgres_version="$(JATOBA_ENV_FILE="$ENV_FILE" "${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW server_version"' | tr -d '\r')"
migration_version="$(JATOBA_ENV_FILE="$ENV_FILE" "${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COALESCE(string_agg(name, E'"'"','"'"' ORDER BY name), E'"'"''"'"') FROM schema_migrations"' | tr -d '\r')"
commit="$(git rev-parse --short HEAD 2>/dev/null || printf unknown)"
cat > "$destination/metadata.json" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "postgres_version": "${postgres_version:-unknown}",
  "jatoba_commit": "$commit",
  "database_name": "$POSTGRES_DB",
  "migration_version": "${migration_version:-unknown}",
  "dump_file": "$(basename "$dump")",
  "dump_size_bytes": $size,
  "checksum_file": "$(basename "$checksum")"
}
EOF
chmod 600 "$dump" "$checksum" "$destination/metadata.json"
echo "Backup created: $dump"
echo "Checksum: $checksum"
