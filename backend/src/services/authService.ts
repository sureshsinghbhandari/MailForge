import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Config } from '../config.js';
import type { Db } from '../db/types.js';
import { AppError, unauthorized } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import { writeAudit } from './audit.js';

export const MIN_PASSWORD_LENGTH = 12;

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface LoginResult extends SessionInfo {
  token: string;
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  hashPassword(password: string): Promise<string> {
    return hash(password); // argon2id with library defaults
  }

  /** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when the users table is empty. */
  async bootstrapAdmin(): Promise<void> {
    const count = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    if ((count.rows[0]?.n ?? 0) > 0) return;
    const password = this.config.ADMIN_PASSWORD;
    if (!password) {
      throw new Error('No admin user exists. Set ADMIN_PASSWORD (and ADMIN_EMAIL) to create the first admin.');
    }
    if (password.length < MIN_PASSWORD_LENGTH && this.config.NODE_ENV !== 'test') {
      this.log.warn('ADMIN_PASSWORD is shorter than 12 characters; acceptable for local development only');
    }
    await this.db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
      this.config.ADMIN_EMAIL.toLowerCase(),
      await this.hashPassword(password),
    ]);
    this.log.info({ email: this.config.ADMIN_EMAIL }, 'initial admin user created');
  }

  async setPassword(email: string, newPassword: string): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(400, 'WEAK_PASSWORD', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const res = await this.db.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE lower(email) = lower($1)',
      [email, await this.hashPassword(newPassword)],
    );
    if (res.rowCount === 0) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    // Invalidate existing sessions for that user.
    await this.db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))', [
      email,
    ]);
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const res = await this.db.query<{ id: string; email: string; password_hash: string }>(
      'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const user = res.rows[0];
    // Always run one argon2 verification so response time does not reveal whether the account exists.
    const passwordOk = await verify(user?.password_hash ?? (await this.getDummyHash()), password).catch(() => false);
    if (!user || !passwordOk) {
      await writeAudit(this.db, {
        userId: user?.id ?? null,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user?.id ?? null,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3_600_000);
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, sha256Hex(token), csrfToken, expiresAt],
    );
    await writeAudit(this.db, { userId: user.id, action: 'auth.login', resourceType: 'user', resourceId: user.id });
    return {
      token,
      csrfToken,
      expiresAt,
      sessionId: inserted.rows[0]!.id,
      userId: user.id,
      email: user.email,
    };
  }

  async authenticateSession(token: string): Promise<SessionInfo | null> {
    if (!token || token.length > 200) return null;
    const res = await this.db.query<{
      id: string;
      user_id: string;
      email: string;
      csrf_token: string;
      expires_at: Date;
    }>(
      `SELECT s.id, s.user_id, u.email, s.csrf_token, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { sessionId: row.id, userId: row.user_id, email: row.email, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }

  async logout(token: string, userId: string | null): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256Hex(token)]);
    await writeAudit(this.db, { userId, action: 'auth.logout', resourceType: 'user', resourceId: userId });
  }

  async deleteExpiredSessions(): Promise<number> {
    const res = await this.db.query('DELETE FROM sessions WHERE expires_at <= now()');
    return res.rowCount;
  }

  /** User that owns requests made while API_AUTH_ENABLED=false (development only). */
  async getFirstUserId(): Promise<string | null> {
    const res = await this.db.query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
    return res.rows[0]?.id ?? null;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hash(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }
}

export function unauthorizedError(): AppError {
  return unauthorized();
}
