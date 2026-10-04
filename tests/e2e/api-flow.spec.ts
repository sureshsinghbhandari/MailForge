import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import nodemailer from 'nodemailer';
import { ADMIN_EMAIL, ADMIN_PASSWORD, MAIL_DOMAIN, SMTP_HOST, SMTP_PORT } from '../support/env.js';
import { sendMail } from '../support/helpers.js';

/**
 * Integration + security tests through the real network path:
 *   SMTP (port 11025) -> capture server -> backend ingest -> database -> REST API / SSE
 * and the way an application's own test-suite would use the automated testing API.
 */

const API = process.env['E2E_API_URL'] ?? `http://127.0.0.1:${process.env['E2E_BACKEND_PORT'] ?? 3101}`;

let admin: APIRequestContext;
let csrf: string;
let apiKey: string;
let keys: APIRequestContext;

test.beforeAll(async () => {
  admin = await playwrightRequest.newContext({ baseURL: API });
  const login = await admin.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBe(true);
  csrf = (await login.json()).data.csrfToken;
  const created = await admin.post('/api/api-keys', { data: { name: 'e2e' }, headers: { 'X-CSRF-Token': csrf } });
  expect(created.status()).toBe(201);
  apiKey = (await created.json()).data.key;
  keys = await playwrightRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${apiKey}` } });
});

test.afterAll(async () => {
  await admin.dispose();
  await keys.dispose();
});

test('health reports every dependency healthy', async () => {
  const res = await playwrightRequest.newContext({ baseURL: API }).then((c) => c.get('/api/health'));
  expect(await res.json()).toEqual({ status: 'healthy', database: 'healthy', smtp: 'healthy' });
});

test('unauthorised API access is rejected', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: API });
  for (const url of ['/api/mailboxes', '/api/messages', '/api/dashboard', '/api/api-keys', '/api/events']) {
    expect((await anon.get(url)).status(), url).toBe(401);
  }
  expect((await anon.post('/api/test/mailbox', { data: {} })).status()).toBe(401);
  const bad = await playwrightRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: 'Bearer mf_not-a-real-key' } });
  expect((await bad.get('/api/mailboxes')).status()).toBe(401);
});

test('an application under test can register, receive a verification email and continue (SMTP -> API)', async () => {
  const mailbox = (await (await keys.post('/api/test/mailbox', { data: { prefix: 'signup', ttlMinutes: 15 } })).json()).data;
  expect(mailbox.email).toMatch(new RegExp(`^signup-[a-z0-9]{6}@${MAIL_DOMAIN.replace(/\./g, '\\.')}$`));

  // The "application" sends its verification email some moments after the test starts waiting.
  setTimeout(() => {
    void sendMail({
      to: mailbox.email,
      subject: 'Verify your account',
      text: 'Your verification code is 482913\nVerify: https://app.example.com/verify?token=abc123',
      html: '<p>Your verification code is <b>482913</b></p><a href="https://app.example.com/verify?token=abc123">Verify</a>',
    });
  }, 500);

  const waited = await keys.post(`/api/test/mailbox/${mailbox.mailboxId}/wait-for-email`, {
    data: { timeoutMs: 20_000, subjectRegex: 'Verify.*[Aa]ccount', from: 'noreply@example.com' },
  });
  const result = (await waited.json()).data;
  expect(result).toMatchObject({
    received: true,
    subject: 'Verify your account',
    verificationCode: '482913',
    verificationUrl: 'https://app.example.com/verify?token=abc123',
  });

  // And the same message is visible through the regular API.
  const message = (await (await keys.get(`/api/messages/${result.messageId}`)).json()).data;
  expect(message.mailboxEmail).toBe(mailbox.email);
  expect(message.codes[0].code).toBe('482913');
});

test('attachments and raw mail survive the full SMTP path byte-for-byte', async () => {
  const mailbox = (await (await keys.post('/api/test/mailbox', { data: {} })).json()).data;
  const payload = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256));
  await sendMail({
    to: mailbox.email,
    subject: 'Attachment test',
    text: 'see attached',
    attachments: [{ filename: 'payload.bin', content: payload }],
  });
  const waited = (await (await keys.post(`/api/test/mailbox/${mailbox.mailboxId}/wait-for-email`, { data: { timeoutMs: 20_000 } })).json()).data;
  expect(waited.received).toBe(true);
  const atts = (await (await keys.get(`/api/messages/${waited.messageId}/attachments`)).json()).data;
  expect(atts).toHaveLength(1);
  const file = await keys.get(`/api/messages/${waited.messageId}/attachments/${atts[0].id}`);
  expect(Buffer.compare(await file.body(), payload)).toBe(0);
  const raw = await keys.get(`/api/messages/${waited.messageId}/raw?download=true`);
  expect(raw.headers()['content-disposition']).toContain('message.eml');
  expect(await raw.text()).toContain('Subject: Attachment test');
});

test('real-time: EMAIL_RECEIVED is pushed over SSE when mail arrives', async () => {
  const mailbox = (await (await keys.post('/api/test/mailbox', { data: {} })).json()).data;
  const controller = new AbortController();
  const stream = await fetch(`${API}/api/events`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();

  await sendMail({ to: mailbox.email, subject: 'SSE please', text: 'code is 111222' });

  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 15_000;
  let event: Record<string, unknown> | undefined;
  while (!event && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const match = /event: EMAIL_RECEIVED\ndata: (.+)\n\n/.exec(buffer);
    if (match) event = JSON.parse(match[1] as string) as Record<string, unknown>;
  }
  controller.abort();
  expect(event).toMatchObject({ type: 'EMAIL_RECEIVED', mailboxId: mailbox.mailboxId, from: 'noreply@example.com', subject: 'SSE please' });
});

test.describe('open relay prevention', () => {
  const rawSmtp = (to: string) =>
    nodemailer
      .createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false, ignoreTLS: true })
      .sendMail({ from: 'attacker@evil.example', to, subject: 'relay test', text: 'x' });

  test('SMTP refuses recipients outside the configured domain', async () => {
    for (const victim of ['victim@gmail.com', `someone@sub.${MAIL_DOMAIN}`, `someone@${MAIL_DOMAIN}.evil.com`]) {
      await expect(rawSmtp(victim), victim).rejects.toMatchObject({ responseCode: 550 });
    }
  });

  test('mail for a mailbox that does not exist is accepted by SMTP but never stored', async () => {
    const before = (await (await admin.get('/api/messages?pageSize=1')).json()).meta.total;
    await rawSmtp(`ghost-${Date.now()}@${MAIL_DOMAIN}`);
    await new Promise((r) => setTimeout(r, 1500)); // > ingest poll interval
    const after = (await (await admin.get('/api/messages?pageSize=1')).json()).meta.total;
    expect(after).toBe(before);
  });
});

test('security: hostile HTML never reaches the client as active content', async () => {
  const mailbox = (await (await keys.post('/api/test/mailbox', { data: {} })).json()).data;
  await sendMail({
    to: mailbox.email,
    subject: 'xss',
    html: '<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe>',
  });
  const { messageId } = (await (await keys.post(`/api/test/mailbox/${mailbox.mailboxId}/wait-for-email`, { data: { timeoutMs: 20_000 } })).json()).data;
  const detail = (await (await keys.get(`/api/messages/${messageId}`)).json()).data;
  expect(detail.html).not.toMatch(/<script|onerror|javascript:|<iframe/i);
  const doc = await keys.get(`/api/messages/${messageId}/html`);
  expect(doc.headers()['content-security-policy']).toContain("default-src 'none'");
});

test('cleanup: an expired mailbox and its mail are removed automatically', async () => {
  test.skip(process.env['E2E_EXTERNAL_STACK'] === '1', 'needs the e2e stack (1 s cleanup interval, 0 h mailbox retention)');
  test.slow(); // minimum TTL is one minute; the cleanup worker runs every second in this stack
  test.setTimeout(150_000);
  const mailbox = (await (await keys.post('/api/test/mailbox', { data: { ttlMinutes: 1 } })).json()).data;
  await sendMail({ to: mailbox.email, subject: 'short lived', text: 'bye' });
  const got = (await (await keys.post(`/api/test/mailbox/${mailbox.mailboxId}/wait-for-email`, { data: { timeoutMs: 20_000 } })).json()).data;
  expect(got.received).toBe(true);

  await expect
    .poll(async () => (await keys.get(`/api/mailboxes/${mailbox.mailboxId}`)).status(), { timeout: 100_000, intervals: [2000] })
    .toBe(404);
  expect((await keys.get(`/api/messages/${got.messageId}`)).status()).toBe(404);
});
