# Production Observability

Jatoba Brain uses small in-process runtime metrics plus the existing PostgreSQL `audit_log`. It does not require a time-series database or a paid monitoring service.

## Endpoints

- `/live` only confirms that the process responds.
- `/ready` verifies the database and reports `HEALTHY`, `DEGRADED`, or `UNHEALTHY`.
- `/health` returns dependency state, process memory, Node version, uptime, and real PostgreSQL pool gauges.
- `/metrics` returns Prometheus-compatible text and requires the normal `BRAIN_API_KEY` authentication. It is not public by default.

Graphify and embeddings are optional dependencies because memory and textual retrieval have fallbacks. Database failure makes readiness `UNHEALTHY`. Graphify unavailable, or an enabled embedding provider without a configured URL, makes the service `DEGRADED`. The current health check does not probe a configured remote embedding URL; provider outage is detected by operation metrics and textual fallback.

| Component | Failure | Brain state | Fallback |
| --- | --- | --- | --- |
| PostgreSQL | offline or unreachable | `UNHEALTHY`, `/ready` returns `503` | none; operations fail with sanitized errors |
| Graphify | binary unavailable or indexing fails | `DEGRADED` | semantic memory and work graph continue |
| Embedding provider | probe/request failure or timeout | `DEGRADED`, `/ready` remains `200` | PostgreSQL textual retrieval |
| Embeddings disabled | provider not configured | `HEALTHY`, `/ready` remains `200` | text-only mode |

## Metric Classes

Runtime counters and latency histograms reset when the Brain process restarts. This is intentional for the first operational version and must be considered when reading a dashboard after restart.

Gauges include:

- process RSS, heap used, heap total, external memory, and uptime;
- database pool total, active, idle, and waiting connections;
- Graphify repository status when the database is available.

Counters include HTTP requests/errors, status families, authentication failures, rate-limit responses, MCP calls/errors, recalls, context retrievals, graph indexing/query success and errors, memory creation snapshots, embedding fallback/provider/dimension/timeout events, and returned context items.

Latency histograms include HTTP requests, MCP calls, recall, context retrieval, graph index, and graph queries. The labels are intentionally bounded. Tool names are allowed; project, repository, task, memory, and request IDs are never Prometheus labels.

The dashboard `Metricas` view reads the same safe runtime snapshot together with persisted project-scoped audit metrics. The audit log remains the source for historical operation facts and does not store request bodies, authorization headers, memory contents, raw exceptions, or secrets.

## Request Correlation and Logs

Every HTTP response receives `X-Request-Id`. A valid incoming ID is preserved; otherwise a random ID is generated. Structured request logs contain timestamp, level, operation, route pattern, method, status, duration, and request ID. Routes are normalized so UUIDs and tool/view path values do not create high-cardinality labels.

`LOG_LEVEL` accepts `error`, `warn`, `info`, or `debug`. The default is `info`; normal successful requests are not printed at that level, while warnings and errors are. Debug logging must not be enabled on a public production endpoint without reviewing log access.

Logs and metrics never include `Authorization`, API keys, `.env`, `DATABASE_URL`, complete memory content, or complete session notes. Client errors remain sanitized.

## Operational Signals

These are initial recommended thresholds, not production SLOs:

- readiness `UNHEALTHY` for more than 2 minutes: investigate the database and migrations;
- sustained 5xx rate above 1% for 5 minutes: inspect structured logs and dependency health;
- database waiting connections continuously above zero: inspect pool exhaustion and slow queries;
- RSS growing across repeated checks: inspect workload, exports, and graph sizes;
- Graphify `ERROR` repeated for one repository: verify repository cleanliness, paths, and Graphify availability;
- embedding provider failures or timeouts increasing: use textual fallback while investigating the provider;
- backup older than the operational backup window: run the existing backup and recovery checks;
- abnormal 401/403 or 429 rates: review clients, credentials, and rate-limit configuration.

Backup scripts are not run automatically and do not fabricate runtime counters. Backup and recovery results remain in their command output and controlled metadata. A future scheduler can publish a safe status file without putting dump paths, credentials, or dump contents in metrics.

## Retention and Restart

`audit_log` currently grows until an operator applies a reviewed retention policy. No automatic deletion is enabled by default. Before enabling cleanup, define `AUDIT_RETENTION_DAYS`, review the required audit window, and run deletion in a controlled maintenance task.

After a Brain restart, runtime counters and histograms reset, while PostgreSQL memory, audit records, migrations, and persisted data remain. Embedding health is cached only in process memory; the provider probe validates a real small vector, with configurable `EMBEDDING_HEALTH_TTL_MS` and `EMBEDDING_HEALTH_TIMEOUT_MS`. The release and observability checks verify this distinction.

## VPS Integration Plan

The VPS can later scrape:

```text
Jatoba Brain /metrics -> Prometheus -> Grafana
```

Keep `/metrics` on localhost, a private network, or behind the existing authenticated reverse proxy. Add Alertmanager only when real operating history justifies it. Until then, use `/ready`, `/health`, authenticated `/metrics`, Docker logs, and the backup/recovery checks.

## Validation

Run the disposable observability check with:

```bash
npm run test:observability
```

It verifies normal health, Graphify degradation, embedding provider failure with textual fallback, PostgreSQL `UNHEALTHY`/not-ready behavior, recovery, metrics, request IDs, secret redaction, and restart behavior without creating persistent monitoring infrastructure.
