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
  res.status(403).json({ error: 'host_not_allowed' });
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

export function dashboardGuard(req: Request,res: Response,next: NextFunction): void {
  const header=req.header('authorization')??'';
  const decoded=header.startsWith('Basic ')?Buffer.from(header.slice(6),'base64').toString('utf8'):'';
  const valid=decoded.startsWith('admin:') && safeEqual(decoded.slice(6),config.apiKey);
  if(valid) {next();return;}
  if(header.startsWith('Bearer ') || req.header('x-jatoba-key')) {authGuard(req,res,next);return;}
  res.setHeader('WWW-Authenticate','Basic realm="Jatoba", charset="UTF-8"');
  res.status(401).json({error:'unauthorized'});
}
