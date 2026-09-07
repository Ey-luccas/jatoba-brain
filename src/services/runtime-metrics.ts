import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';

type Histogram = { count: number; sum: number; buckets: number[] };

const counters = new Map<string, number>();
const histograms = new Map<string, Histogram>();
const buckets = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function metricKey(value: string): string { return value.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80); }

export function increment(name: string, amount = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function observeDuration(name: string, durationMs: number): void {
  const histogram = histograms.get(name) ?? { count: 0, sum: 0, buckets: Array.from({ length: buckets.length }, () => 0) };
  histogram.count += 1;
  histogram.sum += durationMs;
  buckets.forEach((limit, index) => { if (durationMs <= limit) histogram.buckets[index] += 1; });
  histograms.set(name, histogram);
}

export function runtimeSnapshot(): Record<string, number> {
  const result: Record<string, number> = Object.fromEntries(counters);
  for (const [name, histogram] of histograms) {
    result[`${name}_count`] = histogram.count;
    result[`${name}_sum_ms`] = histogram.sum;
  }
  return result;
}

function normalizedRoute(req: Request): string {
  const route = `${req.baseUrl}${req.route?.path ?? req.path}`.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id');
  if (route.startsWith('/api/tools/')) return '/api/tools/:tool';
  if (route.startsWith('/api/dashboard/')) return '/api/dashboard/:view';
  return route || '/unknown';
}

function requestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._-]{8,96}$/.test(value) ? value : randomUUID();
}

export const requestObservability: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const id = requestId(req.header('x-request-id'));
  res.setHeader('X-Request-Id', id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const status = res.statusCode;
    const route = normalizedRoute(req);
    increment('http_requests_total');
    increment(`http_status_${Math.floor(status / 100)}xx_total`);
    if (status >= 400) increment('http_errors_total');
    if (status === 401 || status === 403) increment('auth_failures_total');
    if (status === 429) increment('rate_limit_responses_total');
    observeDuration('http_request_duration_ms', durationMs);
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    if (config.logLevel === 'debug' || (config.logLevel === 'info' && level !== 'info') || (config.logLevel === 'warn' && level !== 'info')) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'jatoba-brain', operation: 'http_request', request_id: id, route, method: req.method, status, duration_ms: Number(durationMs.toFixed(2)) }));
    }
  });
  next();
};

function prometheusName(name: string): string { return `jatoba_${metricKey(name)}`; }
function escapeLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }

export async function prometheusText(): Promise<string> {
  const lines: string[] = [];
  const add = (name: string, value: number, labels = '') => lines.push(`${prometheusName(name)}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`);
  for (const [name, value] of counters) add(name, value);
  for (const [name, histogram] of histograms) {
    buckets.forEach((limit, index) => add(`${name}_bucket`, histogram.buckets[index], `le="${limit}"`));
    add(`${name}_bucket`, histogram.count, 'le="+Inf"');
    add(`${name}_count`, histogram.count);
    add(`${name}_sum_ms`, histogram.sum);
  }
  const memory = process.memoryUsage();
  add('process_rss_bytes', memory.rss);
  add('process_heap_used_bytes', memory.heapUsed);
  add('process_heap_total_bytes', memory.heapTotal);
  add('process_external_bytes', memory.external);
  add('process_uptime_seconds', process.uptime());
  add('db_pool_total', db.totalCount);
  add('db_pool_idle', db.idleCount);
  add('db_pool_waiting', db.waitingCount);
  add('db_pool_active', Math.max(0, db.totalCount - db.idleCount));
  try {
    const rows = (await db.query("SELECT status,count(*)::int AS count FROM repository_graphs GROUP BY status")).rows as Array<{ status: string; count: number }>;
    for (const row of rows) add('graph_status', row.count, `status="${escapeLabel(row.status)}"`);
  } catch { add('graph_status', 0, 'status="unavailable"'); }
  return `${lines.join('\n')}\n`;
}

export function resetRuntimeMetrics(): void { counters.clear(); histograms.clear(); }
