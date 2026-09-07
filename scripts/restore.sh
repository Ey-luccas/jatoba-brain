#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo "Usage: RESTORE_TARGET=disposable RESTORE_CONTAINER=<container> $0 <dump> --yes-i-know-this-overwrites-data" >&2
  exit 2
}

dump="${1:-}"
confirmation="${2:-}"
[[ -n "$dump" && "$confirmation" == "--yes-i-know-this-overwrites-data" ]] || usage
[[ "${RESTORE_TARGET:-}" == "disposable" ]] || { echo "Refusing restore: RESTORE_TARGET must be disposable." >&2; exit 1; }
container="${RESTORE_CONTAINER:-}"
[[ -n "$container" ]] || { echo "RESTORE_CONTAINER is required." >&2; exit 1; }
[[ -f "$dump" ]] || { echo "Dump not found: $dump" >&2; exit 1; }
[[ -s "$dump" ]] || { echo "Dump is empty: $dump" >&2; exit 1; }

checksum="${dump}.sha256"
if [[ -f "$checksum" ]]; then
  (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$checksum")")
else
  echo "Checksum file not found next to dump: $checksum" >&2
  exit 1
fi

db="${RESTORE_DB:-${POSTGRES_DB:-jatoba_test}}"
user="${RESTORE_USER:-${POSTGRES_USER:-jatoba}}"
cat "$dump" | docker exec -i "$container" sh -c \
  'export PGPASSWORD="${POSTGRES_PASSWORD:?target container has no POSTGRES_PASSWORD}"; pg_restore --clean --if-exists --no-owner --exit-on-error -U "$1" -d "$2"' sh "$user" "$db"
echo "Restore completed into disposable target: $container/$db"
