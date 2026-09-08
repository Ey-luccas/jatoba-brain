# Changelog

## [Unreleased]

### Added

- Persistent project and repository memory backed by PostgreSQL and pgvector.
- Graphify structural memory, temporal work graph, hybrid context retrieval, and multi-agent handoff.
- Backup/restore validation, runtime hardening, security checks, load checks, and observability.
- Provider-agnostic embedding health probing with disabled, available, unavailable, TTL, and textual fallback states.

### Security

- Authenticated HTTP/MCP/dashboard paths, rate limits, sanitized errors, protected metrics, and secret-redacted logs.

### Reliability

- Migration checksums and locking, restart/recovery checks, Graphify and embedding degradation handling, and disposable release checks.

### Limitations

- This is a single-node local release candidate without PostgreSQL HA.
- Semantic quality depends on a real embedding provider/model and has not been evaluated in this environment.
- Graphify depends on the languages and constructs supported by the installed CLI.
- Runtime metrics reset after restart; the dashboard does not replace Prometheus/Grafana.
- VPS, production HTTPS, remote MCP, and production network validation remain pending.

### v0.6 Status

- Core operational memory, project views, tasks, decisions, errors, checkpoints, and runtime health are operational locally.
- Extended dashboard visualization and Prometheus/Grafana-grade historical monitoring remain documented limitations, not core release blockers.
