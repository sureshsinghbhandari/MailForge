import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppContext } from '../context.js';
import { authRoutes } from './routes/auth.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { messageRoutes } from './routes/messages.js';
import { systemRoutes } from './routes/system.js';
import { testRoutes } from './routes/test.js';
import {
  authenticate,
  createLimiter,
  csrfGuard,
  errorHandler,
  notFoundHandler,
  requestId,
  requireAuth,
} from './middleware.js';

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  const trust = ctx.config.TRUST_PROXY;
  app.set('trust proxy', trust === 'true' ? true : trust === 'false' ? false : /^\d+$/.test(trust) ? Number(trust) : trust);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: ctx.log,
      genReqId: (req) => (req as express.Request).requestId ?? '',
      // Log the route, never the query string (it may contain search terms) or any header.
      serializers: {
        req: (req: { id: string; method: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: (req.url ?? '').split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customProps: (req) => {
        const principal = (req as express.Request).principal;
        return { userId: principal?.userId ?? undefined, authType: principal?.kind };
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Public: health for Docker / load balancers (intentionally not wrapped in the {success,data} envelope).
  app.get('/api/health', async (_req, res) => {
    const health = await ctx.dashboard.health();
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
  });

  const api = express.Router();
  api.use(authenticate(ctx));
  api.use(csrfGuard(ctx));
  api.use('/auth', authRoutes(ctx));

  const protectedApi = express.Router();
  protectedApi.use(requireAuth);
  protectedApi.use(createLimiter(ctx.config.API_RATE_LIMIT, 'principal'));
  protectedApi.use('/mailboxes', mailboxRoutes(ctx));
  protectedApi.use('/messages', messageRoutes(ctx));
  protectedApi.use('/test', testRoutes(ctx));
  protectedApi.use('/', systemRoutes(ctx));
  api.use(protectedApi);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler(ctx));
  return app;
}
