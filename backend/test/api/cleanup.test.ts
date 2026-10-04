import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMailbox, createTestEnv, deliver, type TestEnv } from '../helpers/testApp.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({
    MAILBOX_RETENTION_HOURS: '0',
    MESSAGE_RETENTION_HOURS: '24',
    ATTACHMENT_RETENTION_HOURS: '1',
  });
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await env.reset();
});

const fileFor = async (messageId: string) => {
  const r = await env.ctx.db.query<{ storage_path: string | null }>('SELECT storage_path FROM attachments WHERE message_id = $1', [messageId]);
  const p = r.rows[0]?.storage_path;
  return p ? path.join(env.attachmentDir, p) : null;
};

describe('cleanup', () => {
  it('permanently removes expired mailboxes with their messages and attachment files', async () => {
    const live = await createMailbox(env);
    const dead = await createMailbox(env);
    await deliver(env, live.email, { subject: 'keep', text: 'x' });
    const { messageId } = await deliver(env, dead.email, { subject: 'drop', text: 'x', attachments: [{ filename: 'f.txt', content: 'abc' }] });
    const file = (await fileFor(messageId))!;
    expect(existsSync(file)).toBe(true);

    await env.ctx.db.query("UPDATE mailboxes SET expires_at = now() - interval '1 second' WHERE id = $1", [dead.id]);
    const result = await env.ctx.cleanup.run();

    expect(result).toMatchObject({ mailboxesDeleted: 1, messagesDeleted: 1, attachmentFilesDeleted: 1 });
    expect(existsSync(file)).toBe(false);
    expect((await env.ctx.db.query('SELECT 1 FROM mailboxes WHERE id = $1', [dead.id])).rowCount).toBe(0);
    expect((await env.ctx.db.query('SELECT 1 FROM messages')).rowCount).toBe(1);
    expect((await env.ctx.db.query('SELECT 1 FROM attachments')).rowCount).toBe(0);
    const audit = await env.ctx.db.query('SELECT 1 FROM audit_logs WHERE action = $1', ['cleanup.run']);
    expect(audit.rowCount).toBe(1);
  });

  it('honours the mailbox retention grace period', async () => {
    const grace = await createTestEnv({ MAILBOX_RETENTION_HOURS: '24' });
    try {
      const a = await createMailbox(grace);
      await grace.ctx.db.query("UPDATE mailboxes SET expires_at = now() - interval '1 hour'");
      expect((await grace.ctx.cleanup.run()).mailboxesDeleted).toBe(0);
      // Expired mailboxes stop receiving mail immediately even before they are purged.
      const out = await grace.ctx.ingest.ingest({
        raw: Buffer.from(`To: ${a.email}\r\nSubject: x\r\n\r\nbody`),
        sourceId: null,
        envelopeRecipients: [a.email],
      });
      expect(out.skipped).toBe('no_matching_mailbox');
      expect((await grace.ctx.cleanup.run(new Date(Date.now() + 25 * 3_600_000))).mailboxesDeleted).toBe(1);
    } finally {
      await grace.close();
    }
  });

  it('removes messages past MESSAGE_RETENTION_HOURS from live mailboxes', async () => {
    const mb = await createMailbox(env);
    const old = await deliver(env, mb.email, { subject: 'old', text: 'x' });
    await deliver(env, mb.email, { subject: 'new', text: 'x' });
    await env.ctx.db.query("UPDATE messages SET received_at = now() - interval '25 hours' WHERE id = $1", [old.messageId]);
    const result = await env.ctx.cleanup.run();
    expect(result.messagesDeleted).toBe(1);
    const left = await env.ctx.db.query<{ subject: string }>('SELECT subject FROM messages');
    expect(left.rows.map((r) => r.subject)).toEqual(['new']);
  });

  it('removes attachment files after ATTACHMENT_RETENTION_HOURS but keeps the message', async () => {
    const mb = await createMailbox(env);
    const { messageId } = await deliver(env, mb.email, { subject: 'att', text: 'x', attachments: [{ filename: 'f.txt', content: 'abc' }] });
    const file = (await fileFor(messageId))!;
    await env.ctx.db.query("UPDATE attachments SET created_at = now() - interval '2 hours'");
    const result = await env.ctx.cleanup.run();
    expect(result.attachmentFilesDeleted).toBe(1);
    expect(existsSync(file)).toBe(false);
    const atts = await env.ctx.messages.listAttachments(messageId);
    expect(atts[0]).toMatchObject({ filename: 'f.txt', stored: false });
    expect((await env.ctx.messages.get(messageId)).subject).toBe('att');
  });

  it('deletes expired sessions', async () => {
    await env.login();
    await env.ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await env.ctx.cleanup.run()).sessionsDeleted).toBe(1);
  });

  it('deleting a mailbox, message or clearing a mailbox removes attachment files', async () => {
    const agent = await env.login();
    const mb = await createMailbox(env);
    const a = await deliver(env, mb.email, { subject: 'a', text: 'x', attachments: [{ filename: 'a.txt', content: '1' }] });
    const b = await deliver(env, mb.email, { subject: 'b', text: 'x', attachments: [{ filename: 'b.txt', content: '2' }] });
    const fa = (await fileFor(a.messageId))!;
    const fb = (await fileFor(b.messageId))!;

    await agent.delete(`/api/messages/${a.messageId}`);
    expect(existsSync(fa)).toBe(false);
    expect(existsSync(fb)).toBe(true);
    await agent.delete(`/api/mailboxes/${mb.id}`);
    expect(existsSync(fb)).toBe(false);
  });
});
