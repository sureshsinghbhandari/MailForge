import type { Queryable } from '../db/types.js';

export interface AuditEntry {
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(q: Queryable, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [entry.userId, entry.action, entry.resourceType, entry.resourceId ?? null, JSON.stringify(entry.metadata ?? {})],
  );
}
