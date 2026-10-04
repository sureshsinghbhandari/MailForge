import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { unauthorized } from '../../lib/errors.js';
import { parseWith } from '../../lib/validation.js';
import { SESSION_COOKIE, createLimiter, requireAuth } from '../middleware.js';
import { ok, requirePrincipal } from '../types.js';

const loginSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  // Only failed attempts count towards the limit, so legitimate logins are never blocked.
  const loginLimiter = createLimiter(ctx.config.LOGIN_RATE_LIMIT, 'ip', { onlyCountFailures: true });

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = parseWith(loginSchema, req.body);
    const session = await ctx.auth.login(email, password);
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.COOKIE_SECURE,
      path: '/',
      expires: session.expiresAt,
    });
    ok(res, { user: { id: session.userId, email: session.email }, csrfToken: session.csrfToken });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    const principal = requirePrincipal(req);
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (principal.kind === 'session' && token) await ctx.auth.logout(token, principal.userId);
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.COOKIE_SECURE,
      path: '/',
    });
    ok(res, { loggedOut: true });
  });

  router.get('/me', async (req, res) => {
    const principal = req.principal;
    if (!principal) throw unauthorized();
    ok(res, {
      user: { id: principal.userId, email: principal.email ?? null },
      authType: principal.kind,
      csrfToken: principal.kind === 'session' ? principal.csrfToken : null,
    });
  });

  return router;
}
