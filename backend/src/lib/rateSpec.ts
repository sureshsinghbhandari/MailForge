export interface RateSpec {
  max: number;
  windowMs: number;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
};

/** Parses specs such as "10/15m", "100/hour" or "1000/1h". */
export function parseRateSpec(spec: string): RateSpec {
  const match = /^(\d+)\/(\d*)(s|m|h|hour|d)$/.exec(spec.trim());
  if (!match) {
    throw new Error(`Invalid rate limit "${spec}" (expected e.g. 10/15m or 100/hour)`);
  }
  const max = Number(match[1]);
  const amount = match[2] ? Number(match[2]) : 1;
  const unitMs = UNIT_MS[match[3] as string] as number;
  if (max < 1 || amount < 1) throw new Error(`Invalid rate limit "${spec}"`);
  return { max, windowMs: amount * unitMs };
}
