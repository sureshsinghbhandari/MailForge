import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { parseWith } from '../../lib/validation.js';
import { requireSession } from '../middleware.js';
import { created, ok, requirePrincipal } from '../types.js';

const MAX_SSE_CONNECTIONS = 200;
const HEARTBEAT_MS = 20_000;

const apiKeySchema = z.object({ name: z.string().trim().min(1).max(100) });

export function systemRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/dashboard', async (_req, res) => {
    ok(res, await ctx.dashboard.dashboard());
  });

  router.get('/system/status', async (_req, res) => {
    const health = await ctx.dashboard.health();
    ok(res, {
      ...health,
      version: process.env['npm_package_version'] ?? '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      lastCleanup: ctx.cleanup.lastResult,
      settings: ctx.dashboard.publicSettings(),
    });
  });

  router.post('/system/cleanup', requireSession, async (_req, res) => {
    ok(res, await ctx.cleanup.run());
  });

  router.get('/api-keys', requireSession, async (_req, res) => {
    ok(res, await ctx.apiKeys.list());
  });

  router.post('/api-keys', requireSession, async (req, res) => {
    const { name } = parseWith(apiKeySchema, req.body);
    const userId = requirePrincipal(req).userId;
    if (!userId) throw new AppError(400, 'NO_USER', 'No user to attach the key to');
    created(res, await ctx.apiKeys.create(name, userId));
  });

  router.delete('/api-keys/:id', requireSession, async (req, res) => {
    await ctx.apiKeys.revoke(req.params['id'] as string, requirePrincipal(req).userId);
    ok(res, { revoked: true });
  });

  // Server-Sent Events. EventSource cannot set headers, so this relies on the session cookie;
  // API-key clients can use fetch() with an Authorization header and read the stream.
  let connections = 0;
  router.get('/events', (req, res) => {
    if (connections >= MAX_SSE_CONNECTIONS) throw new AppError(503, 'TOO_MANY_STREAMS', 'Too many open event streams');
    connections += 1;

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const unsubscribe = ctx.events.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      connections -= 1;
    });
  });

  return router;
}
