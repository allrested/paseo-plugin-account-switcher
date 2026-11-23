import type { UsageBalance, UsageWindow } from "../../shared/contracts";

export type GatewayReading = { plan: string | null; windows: UsageWindow[]; balances: UsageBalance[]; fetchedAt?: string; sessions?: Record<string, string> };
/** A reason the user can read. It never carries the token or any text from a reply, a page or a file. */
export class GatewayUsageError extends Error {
  constructor(message: string, readonly retryAfterMs?: number, readonly stale = false) { super(message); this.name = "GatewayUsageError"; }
}
