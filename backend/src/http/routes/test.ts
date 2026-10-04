import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parseWith } from '../../lib/validation.js';
import { createLimiter } from '../middleware.js';
import { created, ok, requirePrincipal } from '../types.js';

const createSchema = z.object({
  prefix: z.string().max(64).optional(),
  ttlMinutes: z.number().int().positive().optional(),
});

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const waitFields = {
  timeoutMs: z.coerce.number().int().min(100).default(30_000),
  subject: optionalText(500),
  subjectRegex: optionalText(200),
  from: optionalText(320),
  to: optionalText(320),
  messageId: optionalText(998),
  receivedAfter: z.iso
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
};

const waitSchema = z.object(waitFields);
const waitWithMailboxSchema = z.object({ mailboxId: z.string().max(64), ...waitFields });

export function testRoutes(ctx: AppContext): Router {
  const router = Router();
  const creationLimiter = createLimiter(ctx.config.MAILBOX_CREATION_RATE_LIMIT, 'principal');

  // Aborts the wait when the client disconnects so long-polls never pile up.
  const abortOnClose = (req: Request): AbortSignal => {
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    return controller.signal;
  };

  router.post('/mailbox', creationLimiter, async (req, res) => {
    const body = parseWith(createSchema, req.body ?? {});
    const mailbox = await ctx.mailboxes.create(body, { userId: requirePrincipal(req).userId });
    created(res, { email: mailbox.email, mailboxId: mailbox.id, expiresAt: mailbox.expiresAt });
  });

  // Query-string variant: convenient for GET-only HTTP clients.
  router.get('/mailbox/:id/wait-for-email', async (req, res) => {
    const criteria = parseWith(waitSchema, req.query);
    ok(res, await ctx.wait.waitForEmail({ ...criteria, mailboxId: req.params['id'] as string }, abortOnClose(req)));
  });

  router.post('/mailbox/:id/wait-for-email', async (req, res) => {
    const criteria = parseWith(waitSchema, req.body ?? {});
    ok(res, await ctx.wait.waitForEmail({ ...criteria, mailboxId: req.params['id'] as string }, abortOnClose(req)));
  });

  router.post('/wait-for-email', async (req, res) => {
    const criteria = parseWith(waitWithMailboxSchema, req.body ?? {});
    ok(res, await ctx.wait.waitForEmail(criteria, abortOnClose(req)));
  });

  return router;
}
