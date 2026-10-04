import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  buildEmail,
  createMailbox,
  createTestEnv,
  deliver,
  type AuthedAgent,
  type TestEnv,
} from '../helpers/testApp.js';

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

describe('health', () => {
  it('reports healthy without authentication', async () => {
    const res = await request(env.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy', database: 'healthy', smtp: 'healthy' });
  });

  it('returns 503 when the SMTP capture server is down', async () => {
    env.source.healthy = false;
    const res = await request(env.app).get('/api/health');
    env.source.healthy = true;
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unhealthy', smtp: 'unhealthy', database: 'healthy' });
  });
});

describe('authentication', () => {
  it('logs in with a secure session cookie and exposes the user', async () => {
    const res = await request(env.app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { user: { email: ADMIN_EMAIL } } });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] as string;
    expect(cookie).toMatch(/^mf_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('rejects wrong credentials with a generic error', async () => {
    for (const body of [
      { email: ADMIN_EMAIL, password: 'wrong-password-123' },
      { email: 'nobody@example.com', password: ADMIN_PASSWORD },
    ]) {
      const res = await request(env.app).post('/api/auth/login').send(body);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }
  });

  it('validates the login body', async () => {
    const res = await request(env.app).post('/api/auth/login').send({ email: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stores the session token and the password only as hashes', async () => {
    const rows = await env.ctx.db.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(rows.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    const sessions = await env.ctx.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(sessions.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs out and invalidates the session', async () => {
    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect((await agent.get('/api/mailboxes')).status).toBe(401);
  });

  it('requires the CSRF token for state-changing cookie requests', async () => {
    const cookieAgent = request.agent(env.app);
    await cookieAgent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const res = await cookieAgent.post('/api/mailboxes').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
    expect((await cookieAgent.get('/api/mailboxes')).status).toBe(200);
  });

  it('rejects state-changing requests from a foreign origin', async () => {
    const res = await agent.post('/api/mailboxes').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });

  it('rate limits failed logins', async () => {
    const limited = await createTestEnv({ LOGIN_RATE_LIMIT: '3/15m' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(limited.app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'nope-nope-nope-1' });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      // Even the right password is refused while limited.
      const res = await request(limited.app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});

describe('mailboxes', () => {
  it('creates a mailbox with defaults', async () => {
    const res = await agent.post('/api/mailboxes').send({});
    expect(res.status).toBe(201);
    const mb = res.body.data;
    expect(mb.email).toMatch(/^test-[a-z0-9]{6}@mailtest\.local$/);
    expect(mb.status).toBe('active');
    const ttlMs = new Date(mb.expiresAt).getTime() - new Date(mb.createdAt).getTime();
    expect(Math.round(ttlMs / 60_000)).toBe(60);
  });

  it('honours custom prefix and ttl', async () => {
    const res = await agent.post('/api/mailboxes').send({ prefix: 'Signup', ttlMinutes: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toMatch(/^signup-[a-z0-9]{6}@mailtest\.local$/);
    const ttlMs = new Date(res.body.data.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(4 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('rejects invalid prefixes and ttls', async () => {
    expect((await agent.post('/api/mailboxes').send({ prefix: 'bad prefix' })).body.error.code).toBe('INVALID_PREFIX');
    expect((await agent.post('/api/mailboxes').send({ prefix: '../etc' })).body.error.code).toBe('INVALID_PREFIX');
    expect((await agent.post('/api/mailboxes').send({ ttlMinutes: 99999 })).body.error.code).toBe('TTL_TOO_LONG');
    expect((await agent.post('/api/mailboxes').send({ ttlMinutes: -5 })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await agent.post('/api/mailboxes').send({ ttlMinutes: '60' })).status).toBe(400);
    expect((await agent.post('/api/mailboxes').send({ domain: 'evil.com' })).body.error.code).toBe('DOMAIN_NOT_ALLOWED');
  });

  it('lists, gets and deletes mailboxes', async () => {
    const a = (await agent.post('/api/mailboxes').send({ prefix: 'one' })).body.data;
    const b = (await agent.post('/api/mailboxes').send({ prefix: 'two' })).body.data;

    const list = await agent.get('/api/mailboxes');
    expect(list.body.meta).toEqual({ page: 1, pageSize: 25, total: 2 });
    expect(list.body.data.map((m: { id: string }) => m.id)).toEqual([b.id, a.id]);

    const one = await agent.get(`/api/mailboxes/${a.id}`);
    expect(one.body.data).toMatchObject({ id: a.id, messageCount: 0, unreadCount: 0 });

    expect((await agent.delete(`/api/mailboxes/${a.id}`)).status).toBe(200);
    const gone = await agent.get(`/api/mailboxes/${a.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toEqual({ code: 'MAILBOX_NOT_FOUND', message: 'Mailbox not found' });
    expect((await agent.delete(`/api/mailboxes/${a.id}`)).status).toBe(404);
  });

  it('treats malformed ids as not found', async () => {
    expect((await agent.get('/api/mailboxes/not-a-uuid')).status).toBe(404);
    expect((await agent.get('/api/messages/not-a-uuid')).status).toBe(404);
  });

  it('enforces the active mailbox limit', async () => {
    const small = await createTestEnv({ MAX_ACTIVE_MAILBOXES: '2' });
    try {
      const a = await small.login();
      expect((await a.post('/api/mailboxes').send({})).status).toBe(201);
      expect((await a.post('/api/mailboxes').send({})).status).toBe(201);
      const third = await a.post('/api/mailboxes').send({});
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe('MAILBOX_LIMIT_REACHED');
    } finally {
      await small.close();
    }
  });

  it('requires confirmation for bulk deletion', async () => {
    const mb = await createMailbox(env);
    await deliver(env, mb.email, { subject: 'one', text: 'hello' });
    expect((await agent.delete(`/api/mailboxes/${mb.id}/messages`)).status).toBe(400);
    expect((await agent.delete('/api/mailboxes/expired')).status).toBe(400);

    const cleared = await agent.delete(`/api/mailboxes/${mb.id}/messages?confirm=true`);
    expect(cleared.body.data).toEqual({ deleted: 1 });
    expect((await agent.get(`/api/mailboxes/${mb.id}/messages`)).body.meta.total).toBe(0);
  });

  it('deletes expired mailboxes on request', async () => {
    const live = await createMailbox(env);
    const old = await createMailbox(env);
    await env.ctx.db.query("UPDATE mailboxes SET expires_at = now() - interval '1 minute' WHERE id = $1", [old.id]);
    const res = await agent.delete('/api/mailboxes/expired?confirm=true');
    expect(res.body.data).toEqual({ deleted: 1 });
    expect((await agent.get(`/api/mailboxes/${live.id}`)).status).toBe(200);
    expect((await agent.get(`/api/mailboxes/${old.id}`)).status).toBe(404);
  });
});

describe('messages', () => {
  it('lists, filters, searches and paginates messages', async () => {
    const mb = await createMailbox(env);
    const other = await createMailbox(env, { prefix: 'other' });
    await deliver(env, mb.email, { subject: 'Verify your account', text: 'Your verification code is 482913' });
    await deliver(env, mb.email, {
      subject: 'Invoice 20260412',
      text: 'Total $123456.00 see https://billing.example/invoice/1',
      attachments: [{ filename: 'invoice.pdf', content: 'PDFDATA', contentType: 'application/pdf' }],
    });
    await deliver(env, mb.email, { subject: 'Welcome', text: 'Hello there', from: 'support@example.com' });
    await deliver(env, other.email, { subject: 'Elsewhere', text: 'not in first mailbox' });

    const all = await agent.get(`/api/mailboxes/${mb.id}/messages`);
    expect(all.body.meta.total).toBe(3);
    expect(all.body.data.map((m: { subject: string }) => m.subject)).toEqual([
      'Welcome',
      'Invoice 20260412',
      'Verify your account',
    ]);
    expect(all.body.data[0]).not.toHaveProperty('text');

    const q = (qs: string) => agent.get(`/api/messages?${qs}`).then((r) => r.body.data.map((m: { subject: string }) => m.subject).sort());
    expect(await q('search=verification')).toEqual(['Verify your account']);
    expect(await q('search=482913')).toEqual(['Verify your account']);
    expect(await q('search=billing.example')).toEqual(['Invoice 20260412']);
    expect(await q('from=support@')).toEqual(['Welcome']);
    expect(await q(`to=${other.email}`)).toEqual(['Elsewhere']);
    expect(await q('subject=invoice')).toEqual(['Invoice 20260412']);
    expect(await q('code=482913')).toEqual(['Verify your account']);
    expect(await q('url=billing.example')).toEqual(['Invoice 20260412']);
    expect(await q('filter=attachments')).toEqual(['Invoice 20260412']);
    expect(await q('filter=codes')).toEqual(['Verify your account']);
    expect(await q('filter=links')).toEqual(['Invoice 20260412']);
    expect(await q('filter=hour')).toHaveLength(4);
    expect(await q('filter=today')).toHaveLength(4);
    expect(await q('filter=unread')).toHaveLength(4);
    expect(await q('filter=read')).toEqual([]);
    expect(await q(`dateFrom=${new Date(Date.now() + 3_600_000).toISOString()}`)).toEqual([]);
    expect(await q(`mailboxId=${other.id}`)).toEqual(['Elsewhere']);

    const page = await agent.get(`/api/mailboxes/${mb.id}/messages?pageSize=2&page=2`);
    expect(page.body.meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(page.body.data).toHaveLength(1);
  });

  it('treats LIKE wildcards in search literally', async () => {
    const mb = await createMailbox(env);
    await deliver(env, mb.email, { subject: '100% done', text: 'x' });
    await deliver(env, mb.email, { subject: 'something else', text: 'y' });
    const res = await agent.get('/api/messages?search=%25');
    expect(res.body.data.map((m: { subject: string }) => m.subject)).toEqual(['100% done']);
  });

  it('rejects invalid query parameters', async () => {
    expect((await agent.get('/api/messages?pageSize=1000')).status).toBe(400);
    expect((await agent.get('/api/messages?filter=bogus')).status).toBe(400);
    expect((await agent.get('/api/messages?dateFrom=yesterday')).status).toBe(400);
    expect((await agent.get('/api/messages?mailboxId=nope')).status).toBe(400);
  });

  it('returns message detail with codes, links, headers and sanitised html', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, {
      subject: 'Verify your account',
      text: 'Your verification code is 482913\nVerify: https://app.example/verify?token=abc',
      html: '<p onclick="x()">Hi <b>there</b></p><script>alert(1)</script><a href="https://app.example/confirm/9">Confirm</a>',
      replyTo: 'help@example.com',
      cc: 'cc@example.com',
      headers: { 'X-Mailer': 'unit-test', Received: ['from mx1.example by mailtest; Sun, 4 Oct 2026 10:00:00 +0000', 'from app.example by mx1.example; Sun, 4 Oct 2026 09:59:59 +0000'] },
    });
    const res = await agent.get(`/api/messages/${messageId}`);
    expect(res.status).toBe(200);
    const m = res.body.data;
    expect(m).toMatchObject({
      id: messageId,
      mailboxEmail: mb.email,
      subject: 'Verify your account',
      fromAddress: 'noreply@example.com',
      replyTo: 'help@example.com',
      cc: expect.stringContaining('cc@example.com'),
      verificationCode: '482913',
      // "verify" links outrank "confirm" links when picking the single best URL.
      verificationUrl: 'https://app.example/verify?token=abc',
      isRead: false,
    });
    expect(m.html).not.toMatch(/script|onclick|alert/);
    expect(m.html).toContain('<b>there</b>');
    expect(m.codes[0]).toMatchObject({ code: '482913', codeType: 'numeric' });
    expect(m.links.map((l: { url: string }) => l.url)).toEqual([
      'https://app.example/confirm/9',
      'https://app.example/verify?token=abc',
    ]);
    expect(m.links[0]).toMatchObject({ linkType: 'confirm', isVerification: true });
    const headerNames = m.headers.map((h: { name: string }) => h.name);
    expect(headerNames.filter((n: string) => n === 'Received')).toHaveLength(2);
    expect(headerNames).toEqual(expect.arrayContaining(['From', 'To', 'Subject', 'Message-ID', 'X-Mailer', 'Content-Type']));

    expect((await agent.get(`/api/messages/${messageId}/codes`)).body.data[0].code).toBe('482913');
    expect((await agent.get(`/api/messages/${messageId}/links`)).body.data).toHaveLength(2);
  });

  it('marks messages read and deletes them', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, { subject: 'x', text: 'y' });
    expect((await agent.patch(`/api/messages/${messageId}`).send({ isRead: true })).status).toBe(200);
    expect((await agent.get(`/api/messages/${messageId}`)).body.data.isRead).toBe(true);
    expect((await agent.get(`/api/mailboxes/${mb.id}`)).body.data.unreadCount).toBe(0);
    expect((await agent.patch(`/api/messages/${messageId}`).send({ isRead: 'yes' })).status).toBe(400);

    expect((await agent.delete(`/api/messages/${messageId}`)).status).toBe(200);
    expect((await agent.get(`/api/messages/${messageId}`)).status).toBe(404);
  });

  it('serves the raw message inline and as message.eml', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, { subject: 'Raw one', text: 'raw body' });
    const inline = await agent.get(`/api/messages/${messageId}/raw`);
    expect(inline.status).toBe(200);
    expect(inline.headers['content-type']).toMatch(/^text\/plain/);
    expect(inline.text).toContain('Subject: Raw one');
    expect(inline.headers['x-content-type-options']).toBe('nosniff');

    const download = await agent.get(`/api/messages/${messageId}/raw?download=true`);
    expect(download.headers['content-type']).toBe('message/rfc822');
    expect(download.headers['content-disposition']).toBe('attachment; filename="message.eml"');
  });

  it('lists and downloads attachments byte-for-byte', async () => {
    const mb = await createMailbox(env);
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
    const { messageId } = await deliver(env, mb.email, {
      subject: 'File',
      text: 'see attached',
      attachments: [{ filename: 'data.bin', content: bytes, contentType: 'application/octet-stream' }],
    });
    const list = await agent.get(`/api/messages/${messageId}/attachments`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ filename: 'data.bin', size: 8, stored: true });

    const file = await agent
      .get(`/api/messages/${messageId}/attachments/${list.body.data[0].id}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, bytes)).toBe(0);
    expect(file.headers['content-disposition']).toContain('attachment; filename="data.bin"');
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('shows embedded cid images inline as data URIs', async () => {
    const mb = await createMailbox(env);
    const png = Buffer.from('iVBORw0KGgo=', 'base64');
    const { messageId } = await deliver(env, mb.email, {
      subject: 'Inline',
      html: '<img src="cid:logo123"><img src="cid:unknown">',
      attachments: [{ filename: 'logo.png', content: png, contentType: 'image/png', cid: 'logo123' }],
    });
    const html = (await agent.get(`/api/messages/${messageId}`)).body.data.html as string;
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).not.toContain('cid:');
  });
});

describe('automated testing API', () => {
  it('creates a mailbox for tests', async () => {
    const res = await agent.post('/api/test/mailbox').send({ prefix: 'signup' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      email: expect.stringMatching(/^signup-[a-z0-9]{6}@mailtest\.local$/),
      mailboxId: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('returns immediately when a matching email already exists', async () => {
    const { mailboxId, email } = (await agent.post('/api/test/mailbox').send({})).body.data;
    await deliver(env, email, {
      subject: 'Verify your account',
      text: 'Your verification code is 482913\nhttps://example.com/verify?token=abc',
    });
    const res = await agent.get(`/api/test/mailbox/${mailboxId}/wait-for-email?timeoutMs=1000&subject=verify`);
    expect(res.body.data).toMatchObject({
      received: true,
      verificationCode: '482913',
      verificationUrl: 'https://example.com/verify?token=abc',
      subject: 'Verify your account',
    });
  });

  it('waits for an email that arrives later', async () => {
    const { mailboxId, email } = (await agent.post('/api/test/mailbox').send({})).body.data;
    const started = Date.now();
    setTimeout(() => {
      void deliver(env, email, { subject: 'Late arrival', text: 'code: 135790' });
    }, 400);
    const res = await agent.post(`/api/test/mailbox/${mailboxId}/wait-for-email`).send({ timeoutMs: 5000 });
    expect(res.body.data).toMatchObject({ received: true, subject: 'Late arrival', verificationCode: '135790' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('times out with received=false', async () => {
    const { mailboxId } = (await agent.post('/api/test/mailbox').send({})).body.data;
    const res = await agent.post(`/api/test/mailbox/${mailboxId}/wait-for-email`).send({ timeoutMs: 300 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: false });
  });

  it('matches by regex, sender, recipient, message id and time', async () => {
    const { mailboxId, email } = (await agent.post('/api/test/mailbox').send({})).body.data;
    const first = await deliver(env, email, { subject: 'Welcome aboard', text: 'a', from: 'sales@example.com' });
    await deliver(env, email, { subject: 'Verify Your Account now', text: 'b', from: 'noreply@example.com', messageId: '<abc@example.com>' });

    const wait = (body: Record<string, unknown>) =>
      agent.post('/api/test/wait-for-email').send({ mailboxId, timeoutMs: 200, ...body }).then((r) => r.body);

    expect((await wait({ subjectRegex: 'Verify.*Account' })).data.subject).toBe('Verify Your Account now');
    expect((await wait({ subjectRegex: '^welcome' })).data.messageId).toBe(first.messageId);
    expect((await wait({ from: 'sales@example.com' })).data.messageId).toBe(first.messageId);
    expect((await wait({ to: email })).data.received).toBe(true);
    expect((await wait({ messageId: '<abc@example.com>' })).data.subject).toBe('Verify Your Account now');
    expect((await wait({ from: 'nobody@example.com' })).data.received).toBe(false);
    expect((await wait({ subjectRegex: 'Verify', receivedAfter: new Date(Date.now() + 60_000).toISOString() })).data.received).toBe(false);
    const bad = await agent.post('/api/test/wait-for-email').send({ mailboxId, subjectRegex: '(' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_REGEX');
    expect((await agent.post('/api/test/wait-for-email').send({ mailboxId: 'zzz' })).status).toBe(404);
  });

  it('clamps the timeout to MAX_WAIT_TIMEOUT_MS', async () => {
    const quick = await createTestEnv({ MAX_WAIT_TIMEOUT_MS: '1000' });
    try {
      const a = await quick.login();
      const { mailboxId } = (await a.post('/api/test/mailbox').send({})).body.data;
      const started = Date.now();
      const res = await a.post(`/api/test/mailbox/${mailboxId}/wait-for-email`).send({ timeoutMs: 60_000 });
      expect(res.body.data.received).toBe(false);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await quick.close();
    }
  });
});

describe('API keys', () => {
  it('creates, uses, lists and revokes keys', async () => {
    const created = await agent.post('/api/api-keys').send({ name: 'CI pipeline' });
    expect(created.status).toBe(201);
    const { key, id } = created.body.data as { key: string; id: string };
    expect(key).toMatch(/^mf_[A-Za-z0-9_-]{43}$/);

    // Only a hash is stored.
    const stored = await env.ctx.db.query<{ key_hash: string; key_prefix: string }>('SELECT key_hash, key_prefix FROM api_keys');
    expect(stored.rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.key_hash).not.toContain(key);
    expect(key.startsWith(stored.rows[0]?.key_prefix as string)).toBe(true);

    const listed = await agent.get('/api/api-keys');
    expect(listed.body.data[0]).toMatchObject({ id, name: 'CI pipeline', lastUsedAt: null, revokedAt: null });
    expect(JSON.stringify(listed.body)).not.toContain(key);

    // Bearer auth works with no cookie and no CSRF header.
    const viaKey = await request(env.app).post('/api/test/mailbox').set('Authorization', `Bearer ${key}`).send({});
    expect(viaKey.status).toBe(201);
    expect((await agent.get('/api/api-keys')).body.data[0].lastUsedAt).not.toBeNull();

    // Keys cannot manage keys.
    const manage = await request(env.app).get('/api/api-keys').set('Authorization', `Bearer ${key}`);
    expect(manage.status).toBe(403);
    expect(manage.body.error.code).toBe('SESSION_REQUIRED');

    expect((await agent.delete(`/api/api-keys/${id}`)).status).toBe(200);
    const after = await request(env.app).get('/api/mailboxes').set('Authorization', `Bearer ${key}`);
    expect(after.status).toBe(401);
    expect((await agent.get('/api/api-keys')).body.data[0].revokedAt).not.toBeNull();
  });

  it('rejects malformed and unknown keys, and does not fall back to cookies', async () => {
    for (const header of ['Bearer', 'Bearer mf_nope', 'Basic abc', 'Bearer ' + 'x'.repeat(500)]) {
      const res = await request(env.app).get('/api/mailboxes').set('Authorization', header);
      expect(res.status, header).toBe(401);
    }
    // A bad bearer token is a hard failure even with a valid session cookie present.
    const res = await agent.get('/api/mailboxes').set('Authorization', 'Bearer mf_invalid');
    expect(res.status).toBe(401);
  });

  it('requires a name', async () => {
    expect((await agent.post('/api/api-keys').send({ name: '  ' })).status).toBe(400);
  });
});

describe('dashboard and system', () => {
  it('summarises activity', async () => {
    const mb = await createMailbox(env);
    const soon = await createMailbox(env, { ttlMinutes: 5 });
    await deliver(env, mb.email, { subject: 'Verify', text: 'code is 111222' });
    await deliver(env, soon.email, { subject: 'Hello', text: 'hi' });
    const res = await agent.get('/api/dashboard');
    expect(res.body.data).toMatchObject({
      activeMailboxes: 2,
      totalMessages: 2,
      messagesToday: 2,
      unreadMessages: 2,
      expiringSoon: 1,
      smtp: 'healthy',
      database: 'healthy',
      app: 'healthy',
    });
    expect(res.body.data.recentMessages).toHaveLength(2);
  });

  it('reports status and settings without secrets', async () => {
    const res = await agent.get('/api/system/status');
    expect(res.body.data.settings).toMatchObject({ mailDomains: ['mailtest.local'], maxMailboxTtlMinutes: 1440 });
    expect(JSON.stringify(res.body)).not.toMatch(/password|DATABASE_URL/i);
  });

  it('returns a consistent error envelope', async () => {
    const notFound = await agent.get('/api/does-not-exist');
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
    const badJson = await agent.post('/api/mailboxes').set('Content-Type', 'application/json').send('{oops');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('INVALID_JSON');
  });

  it('writes audit log entries without secrets', async () => {
    await agent.post('/api/mailboxes').send({});
    await agent.post('/api/api-keys').send({ name: 'k' });
    const rows = await env.ctx.db.query<{ action: string; metadata: unknown }>('SELECT action, metadata FROM audit_logs ORDER BY id');
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login', 'mailbox.create', 'api_key.create']));
    expect(JSON.stringify(rows.rows)).not.toMatch(/mf_|argon2/);
  });
});

describe('rate limiting', () => {
  it('limits mailbox creation per principal', async () => {
    const limited = await createTestEnv({ MAILBOX_CREATION_RATE_LIMIT: '2/1h' });
    try {
      const a = await limited.login();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await a.post('/api/mailboxes').send({})).status);
      expect(statuses).toEqual([201, 201, 429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('limits overall API usage', async () => {
    const limited = await createTestEnv({ API_RATE_LIMIT: '3/1h' });
    try {
      const a = await limited.login();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await a.get('/api/mailboxes')).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('sanity of helper', () => {
  it('buildEmail produces parseable mail', async () => {
    const raw = await buildEmail({ to: 'a@mailtest.local', subject: 's', text: 't' });
    expect(raw.toString()).toContain('Subject: s');
  });
});
