import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngestWorker } from '../../src/workers/ingestWorker.js';
import type { AppEvent } from '../../src/services/eventBus.js';
import { buildEmail, createMailbox, createTestEnv, deliver, type TestEnv } from '../helpers/testApp.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ MAX_EMAIL_SIZE_MB: '2', MAX_ATTACHMENT_SIZE_MB: '1' });
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await env.reset();
  env.source.messages.clear();
});

describe('ingest pipeline', () => {
  it('stores text, html, links, codes and attachments and publishes EMAIL_RECEIVED', async () => {
    const mb = await createMailbox(env);
    const events: AppEvent[] = [];
    const off = env.ctx.events.subscribe((e) => events.push(e));
    const { messageId } = await deliver(env, mb.email, {
      subject: 'Verify your account',
      text: 'Your verification code is 482913',
      html: '<p>Your verification code is <b>482913</b></p><a href="https://example.com/verify?token=abc">Verify</a>',
      attachments: [{ filename: 'a.txt', content: 'hello' }],
    });
    off();
    expect(events).toEqual([
      {
        type: 'EMAIL_RECEIVED',
        mailboxId: mb.id,
        messageId,
        from: 'noreply@example.com',
        subject: 'Verify your account',
        receivedAt: expect.any(String),
      },
    ]);
    const row = await env.ctx.db.query<Record<string, unknown>>('SELECT * FROM messages WHERE id = $1', [messageId]);
    expect(row.rows[0]).toMatchObject({
      attachment_count: 1,
      link_count: 1,
      code_count: 1,
      is_read: false,
      preview: 'Your verification code is 482913',
    });
    expect(Buffer.from(row.rows[0]!['raw_email'] as Uint8Array).toString()).toContain('Subject: Verify your account');
  });

  it('derives text from html-only mail', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, { subject: 'HTML only', html: '<p>Your OTP is <b>839204</b></p>' });
    const codes = await env.ctx.messages.getCodes(messageId);
    expect(codes.map((c) => c.code)).toEqual(['839204']);
  });

  it('delivers to Bcc recipients known only from the SMTP envelope', async () => {
    const mb = await createMailbox(env);
    const raw = await buildEmail({ to: 'someone@elsewhere.example', subject: 'bcc', text: 'x' });
    const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: ['someone@elsewhere.example', mb.email.toUpperCase()] });
    expect(out.stored).toHaveLength(1);
    expect(out.stored[0]?.mailboxId).toBe(mb.id);
  });

  it('delivers one copy per matching mailbox', async () => {
    const a = await createMailbox(env);
    const b = await createMailbox(env);
    const raw = await buildEmail({ to: [a.email, b.email], subject: 'both', text: 'x', attachments: [{ filename: 'f.txt', content: 'abc' }] });
    const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [a.email, b.email] });
    expect(out.stored).toHaveLength(2);
    const paths = await env.ctx.db.query<{ storage_path: string }>('SELECT storage_path FROM attachments');
    expect(new Set(paths.rows.map((r) => r.storage_path)).size).toBe(2);
  });

  it('is idempotent per source id', async () => {
    const mb = await createMailbox(env);
    const raw = await buildEmail({ to: mb.email, subject: 'dup', text: 'x', attachments: [{ filename: 'f.txt', content: 'abc' }] });
    const input = { raw, sourceId: 'src-1', envelopeRecipients: [mb.email] };
    expect((await env.ctx.ingest.ingest(input)).stored).toHaveLength(1);
    expect((await env.ctx.ingest.ingest(input)).stored).toHaveLength(0);
    expect((await env.ctx.db.query('SELECT 1 FROM messages')).rowCount).toBe(1);
    expect((await env.ctx.db.query('SELECT 1 FROM attachments')).rowCount).toBe(1);
  });

  it('enforces the maximum email size', async () => {
    const mb = await createMailbox(env);
    const raw = await buildEmail({ to: mb.email, subject: 'big', text: 'x'.repeat(2.5 * 1024 * 1024) });
    const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [mb.email] });
    expect(out).toEqual({ stored: [], skipped: 'too_large' });
  });

  it('records but does not store attachments over the size limit', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, {
      subject: 'large attachment',
      text: 'x',
      attachments: [{ filename: 'big.bin', content: Buffer.alloc(1.2 * 1024 * 1024, 1) }],
    });
    const atts = await env.ctx.messages.listAttachments(messageId);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({ filename: 'big.bin', stored: false });
    await expect(env.ctx.messages.openAttachment(messageId, atts[0]!.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_STORED' });
  });

  it.each([
    ['garbage bytes', Buffer.from([0, 255, 254, 1, 2, 3, 4, 5])],
    ['no headers at all', Buffer.from('just some text without any headers')],
    ['truncated multipart', Buffer.from('Content-Type: multipart/mixed; boundary="x"\r\nSubject: broken\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello')],
    ['bad charset and encoding', Buffer.from('Subject: =?utf-99?Q?bad?=\r\nContent-Type: text/plain; charset=nope\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!notbase64!!!')],
    ['empty message', Buffer.alloc(0)],
  ])('survives malformed mail: %s', async (_name, raw) => {
    const mb = await createMailbox(env);
    const out = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [mb.email] });
    expect(out.stored).toHaveLength(1);
    const detail = await env.ctx.messages.get(out.stored[0]!.messageId);
    expect(detail.mailboxEmail).toBe(mb.email);
  });
});

describe('ingest worker', () => {
  it('moves captured messages into the database and removes them from the capture server', async () => {
    const mb = await createMailbox(env);
    env.source.push(await buildEmail({ to: mb.email, subject: 'first', text: 'code is 111222' }), [mb.email]);
    env.source.push(await buildEmail({ to: 'x@other.example', subject: 'foreign', text: 'x' }), ['x@other.example']);
    env.source.push(await buildEmail({ to: mb.email, subject: 'second', text: 'x' }), [mb.email]);

    const worker = new IngestWorker(env.source, env.ctx.ingest, env.ctx.log, 50);
    expect(await worker.pollOnce()).toBe(3);
    expect(env.source.messages.size).toBe(0);
    const subjects = await env.ctx.db.query<{ subject: string }>('SELECT subject FROM messages ORDER BY received_at, subject');
    expect(subjects.rows.map((r) => r.subject).sort()).toEqual(['first', 'second']);
  });

  it('keeps polling in the background and picks up new mail', async () => {
    const mb = await createMailbox(env);
    const worker = new IngestWorker(env.source, env.ctx.ingest, env.ctx.log, 30);
    worker.start();
    try {
      env.source.push(await buildEmail({ to: mb.email, subject: 'background', text: 'x' }), [mb.email]);
      const res = await env.ctx.wait.waitForEmail({ mailboxId: mb.id, subject: 'background', timeoutMs: 3000 });
      expect(res.received).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('survives a failing capture server and drops poison messages', async () => {
    const mb = await createMailbox(env);
    const failing = {
      ...env.source,
      list: async () => {
        throw new Error('connection refused');
      },
    };
    const worker = new IngestWorker(failing as never, env.ctx.ingest, env.ctx.log, 50);
    expect(await worker.pollOnce()).toBe(0);
    expect(worker.lastError).toContain('connection refused');

    // A message whose ingestion keeps throwing is removed after 3 attempts so it cannot block the queue.
    const id = env.source.push(await buildEmail({ to: mb.email, subject: 'poison', text: 'x' }), [mb.email]);
    const original = env.ctx.ingest.ingest.bind(env.ctx.ingest);
    env.ctx.ingest.ingest = async () => {
      throw new Error('boom');
    };
    try {
      const w = new IngestWorker(env.source, env.ctx.ingest, env.ctx.log, 50);
      for (let i = 0; i < 3; i++) await w.pollOnce();
      expect(env.source.messages.has(id)).toBe(false);
    } finally {
      env.ctx.ingest.ingest = original;
    }
  });
});
