import { readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStorage } from '../../src/services/attachmentStorage.js';
import { sanitizeFilename } from '../../src/services/parseEmail.js';
import { buildEmail, createMailbox, createTestEnv, deliver, type AuthedAgent, type TestEnv } from '../helpers/testApp.js';

let env: TestEnv;
let agent: AuthedAgent;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await env.reset();
  agent = await env.login();
});

const UUID = '00000000-0000-4000-8000-000000000000';

describe('unauthorised access', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['get', '/api/mailboxes'],
    ['post', '/api/mailboxes'],
    ['get', `/api/mailboxes/${UUID}`],
    ['delete', `/api/mailboxes/${UUID}`],
    ['get', `/api/mailboxes/${UUID}/messages`],
    ['delete', `/api/mailboxes/${UUID}/messages?confirm=true`],
    ['delete', '/api/mailboxes/expired?confirm=true'],
    ['get', '/api/messages'],
    ['get', `/api/messages/${UUID}`],
    ['patch', `/api/messages/${UUID}`],
    ['delete', `/api/messages/${UUID}`],
    ['get', `/api/messages/${UUID}/raw`],
    ['get', `/api/messages/${UUID}/codes`],
    ['get', `/api/messages/${UUID}/links`],
    ['get', `/api/messages/${UUID}/attachments`],
    ['get', `/api/messages/${UUID}/attachments/${UUID}`],
    ['post', '/api/test/mailbox'],
    ['get', `/api/test/mailbox/${UUID}/wait-for-email`],
    ['post', '/api/test/wait-for-email'],
    ['get', '/api/dashboard'],
    ['get', '/api/system/status'],
    ['post', '/api/system/cleanup'],
    ['get', '/api/api-keys'],
    ['post', '/api/api-keys'],
    ['delete', `/api/api-keys/${UUID}`],
    ['get', '/api/events'],
    ['post', '/api/auth/logout'],
    ['get', '/api/auth/me'],
  ];

  it.each(protectedRoutes)('%s %s requires authentication', async (method, url) => {
    const res = await (request(env.app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('only exposes health and login publicly', async () => {
    expect((await request(env.app).get('/api/health')).status).toBe(200);
    expect((await request(env.app).post('/api/auth/login').send({})).status).toBe(400);
  });

  it('does not accept session tokens or keys in query strings', async () => {
    const key = (await agent.post('/api/api-keys').send({ name: 'q' })).body.data.key as string;
    expect((await request(env.app).get(`/api/mailboxes?api_key=${key}&token=${key}`)).status).toBe(401);
  });

  it('refuses to start with open API auth in production', async () => {
    await expect(
      createTestEnv({ NODE_ENV: 'production', API_AUTH_ENABLED: 'false', ADMIN_PASSWORD: 'a-very-long-password-123' }),
    ).rejects.toThrow(/API_AUTH_ENABLED/);
    await expect(createTestEnv({ NODE_ENV: 'production', ADMIN_PASSWORD: 'change-me-please-123' })).rejects.toThrow(/ADMIN_PASSWORD/);
  });

  it('marks cookies Secure in production', async () => {
    const prod = await createTestEnv({ NODE_ENV: 'production', ADMIN_PASSWORD: 'a-very-long-password-123' });
    try {
      const res = await request(prod.app)
        .post('/api/auth/login')
        .send({ email: 'admin@mailtest.local', password: 'a-very-long-password-123' });
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Secure/i);
    } finally {
      await prod.close();
    }
  });

  it('sends hardening headers and never leaks stack traces', async () => {
    const res = await agent.get('/api/messages/not-a-uuid');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/\bat \S+ \(|node_modules|\.ts:\d+/);
  });
});

describe('SQL injection', () => {
  const payloads = ["' OR '1'='1", "'; DROP TABLE messages; --", "\\' OR 1=1 --", '%27%20OR%201=1', '" OR ""="'];

  it('is neutralised in search and filter parameters', async () => {
    const mb = await createMailbox(env);
    await deliver(env, mb.email, { subject: 'ordinary', text: 'ordinary body' });
    for (const p of payloads) {
      for (const field of ['search', 'from', 'to', 'subject', 'code', 'url']) {
        const res = await agent.get('/api/messages').query({ [field]: p });
        expect(res.status, `${field}=${p}`).toBe(200);
        expect(res.body.data).toEqual([]);
      }
      const wait = await agent.post('/api/test/wait-for-email').send({ mailboxId: mb.id, subject: p, from: p, to: p, messageId: p, timeoutMs: 100 });
      expect(wait.body.data.received).toBe(false);
    }
    const count = await env.ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM messages');
    expect(count.rows[0]?.n).toBe(1);
  });

  it('is neutralised in ids, prefixes and request bodies', async () => {
    for (const p of payloads) {
      expect((await agent.get(`/api/mailboxes/${encodeURIComponent(p)}`)).status).toBe(404);
      expect((await agent.post('/api/mailboxes').send({ prefix: p })).status).toBe(400);
      expect((await agent.post('/api/api-keys').send({ name: p })).status).toBe(201);
      expect((await agent.post('/api/auth/login').send({ email: p, password: p })).status).toBe(401);
    }
    const tables = await env.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email = 'admin@mailtest.local'");
    expect(tables.rows[0]?.n).toBe(1);
  });

  it('stores hostile sender/subject values verbatim and inert', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, {
      subject: "Robert'); DROP TABLE messages;--",
      text: "'); DELETE FROM users; --",
      from: { name: "x'; DROP TABLE users;--", address: 'a@example.com' },
    });
    const m = (await agent.get(`/api/messages/${messageId}`)).body.data;
    expect(m.subject).toBe("Robert'); DROP TABLE messages;--");
    expect((await env.ctx.db.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('rejects regexes that PostgreSQL cannot compile instead of erroring', async () => {
    const mb = await createMailbox(env);
    const res = await agent.post('/api/test/wait-for-email').send({ mailboxId: mb.id, subjectRegex: '[a-' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REGEX');
  });
});

describe('XSS', () => {
  it('never returns active content from hostile HTML emails', async () => {
    const mb = await createMailbox(env);
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<svg onload=alert(1)><script>alert(2)</script></svg>',
      '<body onload=alert(1)>',
      '<object data="data:text/html,<script>alert(1)</script>"></object>',
      '<embed src="javascript:alert(1)">',
      '<form action="javascript:alert(1)"><button>go</button></form>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
      '<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>',
      '<img src="x" onerror="alert(1)" / >',
      '<ScRiPt>alert(1)</sCrIpT>',
    ].join('\n');
    const { messageId } = await deliver(env, mb.email, { subject: '<img src=x onerror=alert(1)>', html: hostile });
    const m = (await agent.get(`/api/messages/${messageId}`)).body.data;
    expect(m.html).not.toMatch(/<script|<iframe|<object|<embed|<form|<svg|<style|<math|\son\w+\s*=|javascript:|data:text/i);
    // The subject is returned as data; the UI renders it as text (React escapes it).
    expect(m.subject).toBe('<img src=x onerror=alert(1)>');
  });

  it('serves HTML bodies as a sandboxed document with its own strict CSP', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, {
      subject: 'html',
      html: '<p>hi</p><script>alert(1)</script><img src="https://tracker.example/p.gif">',
    });
    const blocked = await agent.get(`/api/messages/${messageId}/html`);
    expect(blocked.status).toBe(200);
    expect(blocked.headers['content-type']).toMatch(/^text\/html/);
    const csp = blocked.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data:;');
    expect(csp).not.toMatch(/script-src|unsafe-eval/);
    expect(csp).toMatch(/sandbox allow-popups allow-popups-to-escape-sandbox$/);
    expect(csp).not.toContain('allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(blocked.text).toContain('<p>hi</p>');
    expect(blocked.text).not.toMatch(/<script|alert\(1\)/);

    const withImages = await agent.get(`/api/messages/${messageId}/html?images=true`);
    expect(withImages.headers['content-security-policy']).toContain('img-src data: https: http:');

    const textOnly = await deliver(env, mb.email, { subject: 'plain', text: 'no html here' });
    expect((await agent.get(`/api/messages/${textOnly.messageId}/html`)).body.error.code).toBe('NO_HTML_BODY');
    expect((await request(env.app).get(`/api/messages/${messageId}/html`)).status).toBe(401);
  });

  it('serves attachments and raw mail in a way browsers will not execute', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, {
      subject: 'svg',
      text: 'x',
      attachments: [{ filename: 'evil.html', content: '<script>alert(1)</script>', contentType: 'text/html' }],
    });
    const att = (await agent.get(`/api/messages/${messageId}/attachments`)).body.data[0];
    const res = await agent.get(`/api/messages/${messageId}/attachments/${att.id}`);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    const raw = await agent.get(`/api/messages/${messageId}/raw`);
    expect(raw.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('cannot inject headers through attachment filenames', async () => {
    const mb = await createMailbox(env);
    const raw = await buildEmail({
      to: mb.email,
      subject: 'x',
      text: 'y',
      attachments: [{ filename: 'a"; filename=evil.sh\r\nX-Injected: 1', content: 'data' }],
    });
    const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [mb.email] });
    const messageId = out.stored[0]!.messageId;
    const att = (await agent.get(`/api/messages/${messageId}/attachments`)).body.data[0];
    const res = await agent.get(`/api/messages/${messageId}/attachments/${att.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-injected']).toBeUndefined();
    expect(res.headers['content-disposition']).not.toMatch(/[\r\n]/);
  });
});

describe('path traversal', () => {
  it('sanitises attachment filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('/abs/path/file.txt')).toBe('file.txt');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
    expect(sanitizeFilename('a\u0000b.txt')).toBe('a_b.txt');
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('..')).toBe('attachment');
    expect(sanitizeFilename('x'.repeat(500))).toHaveLength(200);
  });

  it('refuses storage paths that escape the storage root', () => {
    const storage = new AttachmentStorage(path.join(env.attachmentDir, 'root'));
    for (const bad of ['../x', '../../etc/passwd', '/etc/passwd', 'a/../../x', 'a\0b', 'C:\\Windows\\win.ini']) {
      expect(() => storage.resolve(bad), bad).toThrow();
    }
    expect(() => storage.resolve('ab/abcdef')).not.toThrow();
  });

  it('stores attachments under generated names with no user controlled path', async () => {
    const mb = await createMailbox(env);
    await deliver(env, mb.email, {
      subject: 'x',
      text: 'y',
      attachments: [{ filename: '../../../../tmp/pwned.sh', content: '#!/bin/sh' }],
    });
    const row = await env.ctx.db.query<{ storage_path: string; filename: string }>('SELECT storage_path, filename FROM attachments');
    expect(row.rows[0]?.filename).toBe('pwned.sh');
    expect(row.rows[0]?.storage_path).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    const onDisk = await readFile(path.join(env.attachmentDir, row.rows[0]!.storage_path), 'utf8');
    expect(onDisk).toBe('#!/bin/sh');
  });

  it('does not serve a tampered storage_path', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, { subject: 'x', text: 'y', attachments: [{ filename: 'a.txt', content: 'z' }] });
    await env.ctx.db.query("UPDATE attachments SET storage_path = '../../../../etc/passwd'");
    const att = (await agent.get(`/api/messages/${messageId}/attachments`)).body.data[0];
    const res = await agent.get(`/api/messages/${messageId}/attachments/${att.id}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('passwd');
  });

  it('rejects path-like attachment ids', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, { subject: 'x', text: 'y' });
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '..', '%2e%2e%2f']) {
      const res = await agent.get(`/api/messages/${messageId}/attachments/${id}`);
      expect([404, 400]).toContain(res.status);
    }
  });
});

describe('open relay prevention', () => {
  it('drops mail for domains and mailboxes we do not host and never forwards it', async () => {
    const mb = await createMailbox(env);
    const foreign = await buildEmail({ to: 'victim@gmail.com', subject: 'relay me', text: 'spam' });
    const unknown = await buildEmail({ to: 'nobody@mailtest.local', subject: 'no such box', text: 'x' });
    const lookalike = await buildEmail({ to: `${mb.email}.evil.com`, subject: 'lookalike', text: 'x' });
    const subdomain = await buildEmail({ to: mb.email.replace('@', '@sub.'), subject: 'subdomain', text: 'x' });

    for (const raw of [foreign, unknown, lookalike, subdomain]) {
      const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [] });
      expect(out).toEqual({ stored: [], skipped: 'no_matching_mailbox' });
    }
    const out = await env.ctx.ingest.ingest({ raw: foreign, sourceId: null, envelopeRecipients: ['victim@gmail.com'] });
    expect(out.stored).toEqual([]);
    expect((await env.ctx.db.query('SELECT 1 FROM messages')).rowCount).toBe(0);
  });

  it('does not deliver to expired mailboxes', async () => {
    const mb = await createMailbox(env);
    await env.ctx.db.query("UPDATE mailboxes SET expires_at = now() - interval '1 second'");
    const raw = await buildEmail({ to: mb.email, subject: 'late', text: 'x' });
    const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [mb.email] });
    expect(out.skipped).toBe('no_matching_mailbox');
  });

  it('has no code path that sends mail', async () => {
    // The backend has no SMTP client dependency at all; only the (dev-only) test helpers use nodemailer.
    const pkg = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((d) => /nodemailer|smtp/i.test(d))).toEqual([]);
  });
});
