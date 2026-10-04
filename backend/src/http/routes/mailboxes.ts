import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { badRequest } from '../../lib/errors.js';
import { parseWith } from '../../lib/validation.js';
import { createLimiter } from '../middleware.js';
import { ok, created, requirePrincipal } from '../types.js';
import { messageQuerySchema } from './messages.js';

const createSchema = z.object({
  prefix: z.string().max(64).optional(),
  ttlMinutes: z.number().int().positive().optional(),
  domain: z.string().max(253).optional(),
});

const listSchema = z.object({
  status: z.enum(['active', 'expired']).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const confirmSchema = z.object({ confirm: z.literal('true', { error: 'Bulk deletion requires confirm=true' }) });

export function mailboxRoutes(ctx: AppContext): Router {
  const router = Router();
  const creationLimiter = createLimiter(ctx.config.MAILBOX_CREATION_RATE_LIMIT, 'principal');
  const searchLimiter = createLimiter(ctx.config.SEARCH_RATE_LIMIT, 'principal');

  router.post('/', creationLimiter, async (req, res) => {
    const body = parseWith(createSchema, req.body ?? {});
    created(res, await ctx.mailboxes.create(body, { userId: requirePrincipal(req).userId }));
  });

  router.get('/', async (req, res) => {
    const q = parseWith(listSchema, req.query);
    const { items, total } = await ctx.mailboxes.list(q);
    ok(res, items, { page: q.page, pageSize: q.pageSize, total });
  });

  // Must be registered before "/:id".
  router.delete('/expired', async (req, res) => {
    parseWith(confirmSchema, req.query);
    const deleted = await ctx.mailboxes.deleteExpired({ userId: requirePrincipal(req).userId });
    ok(res, { deleted });
  });

  router.get('/:id', async (req, res) => {
    ok(res, await ctx.mailboxes.get(req.params['id'] as string));
  });

  router.delete('/:id', async (req, res) => {
    await ctx.mailboxes.delete(req.params['id'] as string, { userId: requirePrincipal(req).userId });
    ok(res, { deleted: true });
  });

  router.get('/:id/messages', searchLimiter, async (req, res) => {
    const id = req.params['id'] as string;
    await ctx.mailboxes.get(id); // 404 for unknown mailbox
    const q = parseWith(messageQuerySchema, req.query);
    if (q.mailboxId && q.mailboxId !== id) throw badRequest('VALIDATION_ERROR', 'mailboxId conflicts with the path');
    const { items, total } = await ctx.messages.list({ ...q, mailboxId: id });
    ok(res, items, { page: q.page, pageSize: q.pageSize, total });
  });

  router.delete('/:id/messages', async (req, res) => {
    parseWith(confirmSchema, req.query);
    const deleted = await ctx.mailboxes.deleteAllMessages(req.params['id'] as string, {
      userId: requirePrincipal(req).userId,
    });
    ok(res, { deleted });
  });

  return router;
}
