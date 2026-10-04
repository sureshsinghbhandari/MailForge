import { randomBytes } from 'node:crypto';
import type { Db } from '../db/types.js';
import { notFound } from '../lib/errors.js';
import { isUuid } from '../lib/validation.js';
import { writeAudit } from './audit.js';
import { sha256Hex } from './authService.js';

export const API_KEY_PREFIX = 'mf_';

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const toView = (r: ApiKeyRow): ApiKeyView => ({
  id: r.id,
  name: r.name,
  keyPrefix: r.key_prefix,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

export class ApiKeyService {
  constructor(private readonly db: Db) {}

  /**
   * Keys are 256-bit random values, so a plain SHA-256 is an appropriate (and fast) one-way store;
   * slow password hashes protect low-entropy secrets and would make every API call expensive.
   * The plaintext is returned exactly once.
   */
  async create(name: string, userId: string): Promise<ApiKeyView & { key: string }> {
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const res = await this.db.query<ApiKeyRow>(
      `INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES ($1,$2,$3,$4)
       RETURNING id, name, key_prefix, created_at, last_used_at, revoked_at`,
      [userId, name, sha256Hex(key), key.slice(0, 10)],
    );
    const row = res.rows[0]!;
    await writeAudit(this.db, { userId, action: 'api_key.create', resourceType: 'api_key', resourceId: row.id });
    return { ...toView(row), key };
  }

  async list(): Promise<ApiKeyView[]> {
    const res = await this.db.query<ApiKeyRow>(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
         FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC`,
    );
    return res.rows.map(toView);
  }

  async revoke(id: string, userId: string | null): Promise<void> {
    if (!isUuid(id)) throw notFound('API_KEY_NOT_FOUND', 'API key not found');
    const res = await this.db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    if (res.rowCount === 0) throw notFound('API_KEY_NOT_FOUND', 'API key not found');
    await writeAudit(this.db, { userId, action: 'api_key.revoke', resourceType: 'api_key', resourceId: id });
  }

  /** Returns the owning user and key id for a valid, non-revoked key. */
  async authenticate(presented: string): Promise<{ userId: string; keyId: string } | null> {
    if (!presented.startsWith(API_KEY_PREFIX) || presented.length > 200) return null;
    const res = await this.db.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [sha256Hex(presented)],
    );
    const row = res.rows[0];
    if (!row) return null;
    await this.db
      .query(
        `UPDATE api_keys SET last_used_at = now()
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [row.id],
      )
      .catch(() => undefined);
    return { userId: row.user_id, keyId: row.id };
  }
}
