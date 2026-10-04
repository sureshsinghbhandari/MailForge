import type { Request, Response } from 'express';

export interface Principal {
  kind: 'session' | 'apiKey' | 'system';
  userId: string | null;
  sessionId?: string;
  csrfToken?: string;
  keyId?: string;
  email?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      requestId?: string;
    }
  }
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export function ok<T>(res: Response, data: T, meta?: PageMeta, status = 200): void {
  res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
}

export function created<T>(res: Response, data: T): void {
  ok(res, data, undefined, 201);
}

export function requirePrincipal(req: Request): Principal {
  if (!req.principal) throw new Error('requirePrincipal called on an unauthenticated route');
  return req.principal;
}
