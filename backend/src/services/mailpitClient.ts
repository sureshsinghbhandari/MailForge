/** The SMTP capture server's HTTP API. Mailpit implements it; anything else can be adapted to it. */
export interface CapturedMessageSummary {
  id: string;
  size: number;
  /** To + Cc + Bcc addresses (the SMTP envelope recipients as the capture server saw them). */
  recipients: string[];
}

export interface MailSource {
  list(limit: number): Promise<CapturedMessageSummary[]>;
  getRaw(id: string): Promise<Buffer>;
  delete(ids: string[]): Promise<void>;
  isHealthy(): Promise<boolean>;
}

interface MailpitAddress {
  Name?: string;
  Address?: string;
}

interface MailpitListResponse {
  messages?: Array<{
    ID: string;
    Size: number;
    To?: MailpitAddress[] | null;
    Cc?: MailpitAddress[] | null;
    Bcc?: MailpitAddress[] | null;
    Created?: string;
  }>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class MailpitClient implements MailSource {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async list(limit: number): Promise<CapturedMessageSummary[]> {
    const res = await this.request(`/api/v1/messages?limit=${limit}`);
    const body = (await res.json()) as MailpitListResponse;
    // Mailpit lists newest first; ingest oldest first so inbox order matches arrival order.
    return (body.messages ?? [])
      .map((m) => ({
        id: m.ID,
        size: m.Size,
        recipients: [...(m.To ?? []), ...(m.Cc ?? []), ...(m.Bcc ?? [])]
          .map((a) => a.Address?.toLowerCase())
          .filter((a): a is string => !!a),
      }))
      .reverse();
  }

  async getRaw(id: string): Promise<Buffer> {
    const res = await this.request(`/api/v1/message/${encodeURIComponent(id)}/raw`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request('/api/v1/messages', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: ids }),
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/livez`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`Mail source ${init.method ?? 'GET'} ${path} failed with HTTP ${res.status}`);
    }
    return res;
  }
}
