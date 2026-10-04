import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailpitClient } from '../../src/services/mailpitClient.js';
import { createMailbox, createTestEnv, deliver, ADMIN_EMAIL, ADMIN_PASSWORD, type TestEnv } from '../helpers/testApp.js';

let env: TestEnv;
let server: http.Server;
let base: string;

beforeAll(async () => {
  env = await createTestEnv();
  server = http.createServer(env.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await env.close();
});

async function sessionCookie(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  return (res.headers.getSetCookie()[0] as string).split(';')[0] as string;
}

async function readEvents(cookie: string, until: (events: Array<Record<string, unknown>>) => boolean, trigger: () => Promise<void>) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const events: Array<Record<string, unknown>> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  await trigger();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    for (const block of buffer.split('\n\n').slice(0, -1)) {
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
  }
  ac.abort();
  return events;
}

describe('server-sent events', () => {
  it('requires authentication', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });

  it('pushes EMAIL_RECEIVED when mail arrives', async () => {
    const cookie = await sessionCookie();
    const mb = await createMailbox(env);
    const events = await readEvents(
      cookie,
      (e) => e.some((x) => x['type'] === 'EMAIL_RECEIVED'),
      async () => {
        await deliver(env, mb.email, { subject: 'Verify your account', text: 'code: 482913' });
      },
    );
    expect(events.find((e) => e['type'] === 'EMAIL_RECEIVED')).toEqual({
      type: 'EMAIL_RECEIVED',
      mailboxId: mb.id,
      messageId: expect.any(String),
      from: 'noreply@example.com',
      subject: 'Verify your account',
      receivedAt: expect.any(String),
    });
  });

  it('also announces mailbox deletion and cleans up listeners on disconnect', async () => {
    const cookie = await sessionCookie();
    const before = env.ctx.events.listenerCount();
    const mb = await createMailbox(env);
    const events = await readEvents(
      cookie,
      (e) => e.some((x) => x['type'] === 'MAILBOX_DELETED'),
      async () => {
        await env.ctx.mailboxes.delete(mb.id, { userId: null });
      },
    );
    expect(events.map((e) => e['type'])).toContain('MAILBOX_DELETED');
    await new Promise((r) => setTimeout(r, 100));
    expect(env.ctx.events.listenerCount()).toBe(before);
  });
});

describe('MailpitClient', () => {
  it('speaks the Mailpit REST API', async () => {
    const calls: string[] = [];
    const fake = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === '/livez') return void res.end('ok');
      if (req.url?.startsWith('/api/v1/messages') && req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        return void res.end(
          JSON.stringify({
            total: 2,
            messages: [
              { ID: 'newer', Size: 10, To: [{ Address: 'A@Mailtest.local' }], Cc: null, Bcc: [{ Address: 'b@mailtest.local' }] },
              { ID: 'older', Size: 20, To: [{ Address: 'c@mailtest.local' }] },
            ],
          }),
        );
      }
      if (req.url === '/api/v1/message/older/raw') return void res.end('RAW-OLDER');
      if (req.url === '/api/v1/messages' && req.method === 'DELETE') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          calls.push(`BODY ${body}`);
          res.end('ok');
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    try {
      const client = new MailpitClient(`http://127.0.0.1:${(fake.address() as AddressInfo).port}/`);
      expect(await client.isHealthy()).toBe(true);
      const list = await client.list(50);
      expect(list).toEqual([
        { id: 'older', size: 20, recipients: ['c@mailtest.local'] },
        { id: 'newer', size: 10, recipients: ['a@mailtest.local', 'b@mailtest.local'] },
      ]);
      expect((await client.getRaw('older')).toString()).toBe('RAW-OLDER');
      await client.delete(['older', 'newer']);
      expect(calls).toContain('BODY {"IDs":["older","newer"]}');
      await expect(client.getRaw('missing')).rejects.toThrow(/404/);
    } finally {
      fake.close();
    }
    expect(await new MailpitClient('http://127.0.0.1:1').isHealthy()).toBe(false);
  });
});
