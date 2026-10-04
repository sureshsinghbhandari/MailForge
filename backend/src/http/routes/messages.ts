import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parseWith } from '../../lib/validation.js';
import { notFound } from '../../lib/errors.js';
import { buildEmailDocument, emailCsp } from '../../services/emailDocument.js';
import { createLimiter } from '../middleware.js';
import { ok, requirePrincipal } from '../types.js';

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
const optionalDate = z.iso
  .datetime({ offset: true })
  .optional()
  .transform((v) => (v ? new Date(v) : undefined));

export const messageQuerySchema = z.object({
  mailboxId: z.uuid().optional(),
  search: optionalText(200),
  from: optionalText(200),
  to: optionalText(200),
  subject: optionalText(200),
  code: optionalText(32),
  url: optionalText(500),
  dateFrom: optionalDate,
  dateTo: optionalDate,
  filter: z.enum(['all', 'unread', 'read', 'attachments', 'codes', 'links', 'today', 'hour']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const patchSchema = z.object({ isRead: z.boolean() });
const downloadFlag = z.object({ download: z.enum(['true', 'false', '1', '0']).optional() });
const htmlFlags = z.object({ images: z.enum(['true', 'false']).optional() });

/** Characters that could break out of a quoted Content-Disposition filename (header injection). */
function contentDispositionFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function messageRoutes(ctx: AppContext): Router {
  const router = Router();
  const searchLimiter = createLimiter(ctx.config.SEARCH_RATE_LIMIT, 'principal');
  const downloadLimiter = createLimiter(ctx.config.DOWNLOAD_RATE_LIMIT, 'principal');

  router.get('/', searchLimiter, async (req, res) => {
    const q = parseWith(messageQuerySchema, req.query);
    const { items, total } = await ctx.messages.list(q);
    ok(res, items, { page: q.page, pageSize: q.pageSize, total });
  });

  router.get('/:id', async (req, res) => {
    ok(res, await ctx.messages.get(req.params['id'] as string));
  });

  router.patch('/:id', async (req, res) => {
    const { isRead } = parseWith(patchSchema, req.body);
    await ctx.messages.setRead(req.params['id'] as string, isRead);
    ok(res, { isRead });
  });

  router.delete('/:id', async (req, res) => {
    await ctx.messages.delete(req.params['id'] as string, { userId: requirePrincipal(req).userId });
    ok(res, { deleted: true });
  });

  // Standalone, sanitised HTML document for the viewer's sandboxed iframe. It carries its own strict
  // CSP header, independent of the app's, and loads remote images only when explicitly requested.
  router.get('/:id/html', async (req, res) => {
    const { images } = parseWith(htmlFlags, req.query);
    const fragment = await ctx.messages.getSanitisedHtml(req.params['id'] as string);
    if (fragment === null) throw notFound('NO_HTML_BODY', 'This message has no HTML part');
    const allowImages = images === 'true';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', emailCsp(allowImages));
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(buildEmailDocument(fragment, allowImages));
  });

  router.get('/:id/raw', downloadLimiter, async (req, res) => {
    const { download } = parseWith(downloadFlag, req.query);
    const raw = await ctx.messages.getRaw(req.params['id'] as string);
    const asDownload = download === 'true' || download === '1';
    res.setHeader('Content-Type', asDownload ? 'message/rfc822' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', asDownload ? 'attachment; filename="message.eml"' : 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(raw);
  });

  router.get('/:id/codes', async (req, res) => {
    ok(res, await ctx.messages.getCodes(req.params['id'] as string));
  });

  router.get('/:id/links', async (req, res) => {
    ok(res, await ctx.messages.getLinks(req.params['id'] as string));
  });

  router.get('/:id/attachments', async (req, res) => {
    ok(res, await ctx.messages.listAttachments(req.params['id'] as string));
  });

  router.get('/:id/attachments/:attachmentId', downloadLimiter, async (req, res) => {
    const file = await ctx.messages.openAttachment(
      req.params['id'] as string,
      req.params['attachmentId'] as string,
    );
    // Never let the browser interpret attachment bytes: force download, no sniffing, sandboxed.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', contentDispositionFilename(file.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  });

  return router;
}
