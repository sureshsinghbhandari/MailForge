import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { parseRateSpec } from '../lib/rateSpec.js';
import { safeEqual } from '../services/authService.js';
import type { Principal } from './types.js';

export const SESSION_COOKIE = 'mf_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/** Resolves the caller from `Authorization: Bearer <api key>` or the session cookie. */
export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization');
    if (header !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      const found = match ? await ctx.apiKeys.authenticate(match[1] as string) : null;
      if (!found) throw unauthorized('Invalid or revoked API key');
      req.principal = { kind: 'apiKey', userId: found.userId, keyId: found.keyId };
      return next();
    }

    const cookie = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (cookie) {
      const session = await ctx.auth.authenticateSession(cookie);
      if (session) {
        req.principal = {
          kind: 'session',
          userId: session.userId,
          sessionId: session.sessionId,
          csrfToken: session.csrfToken,
          email: session.email,
        };
        return next();
      }
    }

    if (!ctx.config.API_AUTH_ENABLED) {
      // Development-only escape hatch (rejected by config validation in production).
      req.principal = { kind: 'system', userId: await ctx.auth.getFirstUserId() };
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.principal) throw unauthorized();
  next();
};

/** Management endpoints (API keys) are for interactive admins, not for API keys themselves. */
export const requireSession: RequestHandler = (req, _res, next) => {
  if (req.principal?.kind === 'apiKey') {
    throw forbidden('SESSION_REQUIRED', 'This endpoint requires an interactive login, not an API key');
  }
  next();
};

/**
 * CSRF defence for cookie sessions: a per-session token in a custom header (cannot be set cross-site)
 * plus an Origin check. API-key callers are not cookie-based and so not CSRF-able.
 */
export function csrfGuard(ctx: AppContext): RequestHandler {
  const allowed = new Set(
    ctx.config.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();

    const origin = req.header('origin');
    if (origin && !allowed.has(origin) && hostOf(origin) !== req.header('host')) {
      throw forbidden('BAD_ORIGIN', 'Cross-origin request rejected');
    }

    const principal = req.principal;
    if (principal?.kind === 'session') {
      const sent = req.header('x-csrf-token') ?? '';
      if (!principal.csrfToken || !safeEqual(sent, principal.csrfToken)) {
        throw forbidden('CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token');
      }
    }
    next();
  };
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export function createLimiter(
  spec: string,
  scope: 'ip' | 'principal',
  opts: { onlyCountFailures?: boolean } = {},
): RequestHandler {
  const { max, windowMs } = parseRateSpec(spec);
  return rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests: opts.onlyCountFailures ?? false,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const p: Principal | undefined = req.principal;
      if (scope === 'principal' && p) return `${p.kind}:${p.keyId ?? p.sessionId ?? p.userId ?? 'system'}`;
      return ipKeyGenerator(req.ip ?? '0.0.0.0');
    },
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down')),
  });
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'));
}

export function errorHandler(ctx: AppContext): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err as AppError & { details: unknown });
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'VALIDATION_ERROR';
      message = 'Request validation failed';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (isHttpError(err)) {
      status = err.status;
      code = err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST';
      message = err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message;
      if (err.type === 'entity.parse.failed') code = 'INVALID_JSON';
    }

    if (status >= 500) {
      // The stack goes to the log only; clients never see it.
      ctx.log.error({ requestId: req.requestId, err: err instanceof Error ? err.stack : String(err) }, 'request failed');
    }
    res.status(status).json({
      success: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    });
  };
}

function isHttpError(err: unknown): err is { status: number; type: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { type?: unknown }).type === 'string'
  );
}
