# Backup, Restore and Recovery

## Backup

`scripts/backup.sh` uses PostgreSQL `pg_dump -Fc` inside the Compose `postgres` container. It creates a UTC-dated directory under `BACKUP_DIR` (default `backups/`) containing:

- `jatoba-<timestamp>.dump`
- `jatoba-<timestamp>.dump.sha256`
- `metadata.json`

The metadata contains timestamp, PostgreSQL version, Jatoba commit, database name, migration names, dump size and checksum filename. It never contains `DATABASE_URL`, passwords, tokens or API keys. The dump and metadata are created with mode `0600`; backups are ignored by Git.

Production example:

```bash
BACKUP_ENV_FILE=.env ./scripts/backup.sh
```

The environment file is read locally, but secrets are used only by the container command and are not printed.

## Restore

Restore is deliberately restricted to an explicitly disposable target:

```bash
RESTORE_TARGET=disposable \
RESTORE_CONTAINER=<disposable-postgres-container> \
RESTORE_DB=jatoba_test \
RESTORE_USER=jatoba \
./scripts/restore.sh backups/2026-09-06/jatoba-<timestamp>.dump \
  --yes-i-know-this-overwrites-data
```

The adjacent SHA-256 file is required and verified before `pg_restore` starts. The script refuses an absent dump, missing checksum, missing target marker or missing explicit overwrite confirmation. It never assumes production and uses `--clean --if-exists` only after those guards pass.

## Verification and Recovery

`npm run test:recovery` starts two randomly named Compose projects with disposable volumes. It seeds the source through the real MCP HTTP tools, dumps the source database, restores into a second empty PostgreSQL container, runs the migration runner again, starts Brain against the restored database and verifies counts plus `health`, `recall`, `project_context`, `relations_query`, `context_retrieve`, `agent_handoff` and `export_docs`.

The test also verifies embedding vector and provider/model/dimension/version metadata, migration history 001 through 005, checksum rejection for a corrupted copy, missing-file rejection and the graph metadata behavior. It never uses `down -v`, `docker volume prune` or `docker system prune`.

## Graphify

PostgreSQL metadata for repository graphs is part of the critical database backup. `graph.json` files are regenerable artifacts and are not part of the database dump. On a new server, a graph without its file is expected to report `MISSING` or `STALE`; run `graph_index` explicitly to rebuild it.

## Security

Do not put `.env`, private keys, tokens or credentials in the backup directory. Do not paste dump contents into logs. Keep backup permissions restricted and store copies outside the application host when appropriate.

## Retention recommendation

No destructive retention automation is implemented. A future operational policy may retain 7 daily, 4 weekly and 3 monthly backups, subject to storage and recovery testing.
