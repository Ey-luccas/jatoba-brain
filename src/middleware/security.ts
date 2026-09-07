import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimit(kind: 'health' | 'api' | 'mcp'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.rateLimit.enabled) { next(); return; }
    const now = Date.now();
    const windowMs = Math.max(1000, config.rateLimit.windowMs);
    const max = Math.max(1, kind === 'health' ? config.rateLimit.healthMax : kind === 'mcp' ? config.rateLimit.mcpMax : config.rateLimit.max);
    const key = `${kind}:${clientKey(req)}`;
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 10000) for (const [entry, value] of buckets) if (value.resetAt <= now) buckets.delete(entry);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

export function corsGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (!origin || config.corsOrigins.includes(origin)) { next(); return; }
  if (config.corsOrigins.length === 0) {
    if (req.method === 'OPTIONS') { res.status(403).json({ error: 'origin_not_allowed' }); return; }
    next(); return;
  }
  res.status(403).json({ error: 'origin_not_allowed' });
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (config.hstsEnabled && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

export function resetRateLimitsForTests(): void { buckets.clear(); }
