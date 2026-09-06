import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hostGuard(req: Request, res: Response, next: NextFunction): void {
  const hostname = req.hostname;
  if (config.allowedHosts.includes('*') || config.allowedHosts.includes(hostname)) {
    next();
    return;
  }
  res.status(403).json({ error: 'host_not_allowed', hostname });
}

export function authGuard(req: Request, res: Response, next: NextFunction): void {
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const alternate = req.header('x-jatoba-key') ?? '';
  const provided = bearer || alternate;

  if (provided && safeEqual(provided, config.apiKey)) {
    next();
    return;
  }

  res.status(401).json({ error: 'unauthorized' });
}
