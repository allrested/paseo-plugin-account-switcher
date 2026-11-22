import { lstat, readFile } from "node:fs/promises";
import type { GatewayUsage, UsageBalance, UsageUnit, UsageWindow } from "../../shared/contracts";
import { retryAfter } from "./claude";
import { readDashboardUsage, type DashboardDependencies } from "./dashboard";

import { GatewayUsageError, type GatewayReading } from "./gateway-reading";
export { GatewayUsageError, type GatewayReading };
type Endpoint = Extract<GatewayUsage, { kind: "endpoint" }>;
type FileUsage = Extract<GatewayUsage, { kind: "file" }>;
export type GatewayCredentials = { baseUrl: string; token: string };
export type GatewayDependencies = { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number;
  /** For a dashboard: whose reading this is (reads are spaced per account), and the browser seams. */
  accountId?: string; openTab?: DashboardDependencies["openTab"]; sleep?: DashboardDependencies["sleep"]; force?: boolean };

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const STALE_MS = 30 * 60_000;
const UNITS: readonly UsageUnit[] = ["credits", "usd", "requests", "tokens"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined;
    else if (isObject(current)) current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    else return undefined;
  }
  return current;
}
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}
function numberAt(body: unknown, path: string | undefined): number | null {
  if (!path) return null;
  const value = toNumber(at(body, path));
  if (value === null) throw new GatewayUsageError(`The usage reply has no number at ${path}.`);
  return value;
}
/** An ISO time, or epoch seconds or milliseconds. */
function toTime(value: unknown): string | null {
  const epoch = toNumber(value);
  const ms = epoch !== null ? (epoch < 1e11 ? epoch * 1000 : epoch) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new GatewayUsageError("The usage reply is too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readEndpointUsage(usage: Endpoint, gateway: GatewayCredentials, deps: GatewayDependencies = {}): Promise<GatewayReading> {
  const origin = new URL(gateway.baseUrl).origin;
  const url = new URL(usage.path, origin);
  // The token belongs to the gateway. A path that resolves anywhere else is refused before any request.
  if (url.origin !== origin) throw new GatewayUsageError("The usage endpoint is not on the gateway.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal?.aborted) abort();
  deps.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, TIMEOUT_MS);
  timeout.unref();
  try {
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(url.href, {
        method: "GET", headers: { Authorization: `Bearer ${gateway.token}`, Accept: "application/json" }, signal: controller.signal, redirect: "error",
      });
    } catch { throw new GatewayUsageError("The gateway's usage request failed."); }
    if (response.status === 401 || response.status === 403) throw new GatewayUsageError(`The gateway refused the token (${response.status}).`);
    if (!response.ok) throw new GatewayUsageError(`The gateway's usage request failed (${response.status}).`,
      response.status === 429 ? retryAfter(response.headers.get("retry-after"), (deps.now ?? Date.now)()) : undefined);
    let body: unknown;
    const text = await readBody(response).catch(error => { throw error instanceof GatewayUsageError ? error : new GatewayUsageError("The gateway's usage request failed."); });
    try { body = JSON.parse(text); } catch { throw new GatewayUsageError("The usage reply is not JSON."); }
    return endpointReading(usage, body);
  } finally {
    clearTimeout(timeout);
    deps.signal?.removeEventListener("abort", abort);
  }
}

function endpointReading(usage: Endpoint, body: unknown): GatewayReading {
  const { fields } = usage;
  const scaled = (path: string | undefined) => { const value = numberAt(body, path); return value === null ? null : value / usage.divisor; };
  let used = scaled(fields.used), limit = scaled(fields.limit), remaining = scaled(fields.remaining);
  const unlimited = fields.unlimited ? at(body, fields.unlimited) === true : false;
  // A limit of 0 is how gateways report "no limit". It is never a divisor.
  if (unlimited || limit === 0) { limit = null; remaining = null; }
  else if (limit === null && used !== null && remaining !== null) limit = used + remaining;
  else if (remaining === null && used !== null && limit !== null) remaining = limit - used;
  else if (used === null && limit !== null && remaining !== null) used = limit - remaining;
  const balances: UsageBalance[] = fields.used || fields.limit || fields.remaining
    ? [{ id: "balance", label: usage.label, used, remaining, limit, unit: usage.unit, detail: unlimited ? "Unlimited" : null }] : [];
  const windows: UsageWindow[] = fields.usedPercent
    ? [{ id: "window", label: usage.label, usedPercent: numberAt(body, fields.usedPercent), windowDurationMins: null, resetsAt: fields.resetsAt ? toTime(at(body, fields.resetsAt)) : null }] : [];
  const plan = fields.plan ? at(body, fields.plan) : null;
  return { plan: typeof plan === "string" && plan.trim() ? plan.trim().slice(0, 80) : null, windows, balances };
}

const text = (value: unknown, max: number): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
/** Reads `{ fetchedAt, report }` where `report` is a Paseo usage report another tool wrote. */
export async function readFileUsage(usage: FileUsage, deps: Pick<GatewayDependencies, "now"> = {}): Promise<GatewayReading> {
  let raw: string;
  try {
    // lstat, not stat: a link could point the reader at any file the daemon can read.
    const stat = await lstat(usage.path);
    if (!stat.isFile()) throw new GatewayUsageError("The usage file is not a regular file.");
    if (stat.size > MAX_BYTES) throw new GatewayUsageError("The usage file is too large.");
    raw = await readFile(usage.path, "utf8");
  } catch (error) {
    if (error instanceof GatewayUsageError) throw error;
    throw new GatewayUsageError((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "The usage file is missing." : "The usage file cannot be read.");
  }
  let saved: unknown;
  try { saved = JSON.parse(raw); } catch { throw new GatewayUsageError("The usage file is not a usage report."); }
  const report = isObject(saved) ? saved.report : undefined;
  const fetchedMs = isObject(saved) && typeof saved.fetchedAt === "string" ? Date.parse(saved.fetchedAt) : NaN;
  if (!isObject(report) || !Number.isFinite(fetchedMs)) throw new GatewayUsageError("The usage file is not a usage report.");
  if (report.status !== "available") throw new GatewayUsageError("The usage file reports no usage.");
  if ((deps.now ?? Date.now)() - fetchedMs > STALE_MS) throw new GatewayUsageError("The usage file is older than 30 minutes.", undefined, true);
  const windows: UsageWindow[] = [], balances: UsageBalance[] = [];
  for (const [index, item] of (Array.isArray(report.windows) ? report.windows : []).slice(0, 24).entries()) {
    if (!isObject(item)) continue;
    const usedPct = toNumber(item.usedPct), remainingPct = toNumber(item.remainingPct);
    const label = text(item.label, 80);
    if (!label) continue;
    windows.push({ id: text(item.id, 80) ?? `window-${index}`, label, usedPercent: usedPct ?? (remainingPct === null ? null : 100 - remainingPct),
      windowDurationMins: null, resetsAt: toTime(item.resetsAt) });
  }
  for (const [index, item] of (Array.isArray(report.balances) ? report.balances : []).slice(0, 24).entries()) {
    if (!isObject(item)) continue;
    const label = text(item.label, 80), unit = UNITS.find(u => u === item.unit);
    if (!label || !unit) continue;
    balances.push({ id: text(item.id, 80) ?? `balance-${index}`, label, used: toNumber(item.used), remaining: toNumber(item.remaining), limit: toNumber(item.limit), unit, detail: null });
  }
  return { plan: text(report.planLabel, 80), windows, balances, fetchedAt: new Date(fetchedMs).toISOString() };
}

export async function readGatewayUsage(usage: GatewayUsage, gateway: () => Promise<GatewayCredentials>, deps: GatewayDependencies = {}): Promise<GatewayReading> {
  if (usage.kind === "file") return readFileUsage(usage, deps);
  if (usage.kind === "dashboard") {
    const now = deps.now;
    return readDashboardUsage(deps.accountId ?? "", usage, { openTab: deps.openTab, sleep: deps.sleep, force: deps.force, ...(now ? { now: () => new Date(now()) } : {}) });
  }
  let credentials: GatewayCredentials;
  try { credentials = await gateway(); } catch { throw new GatewayUsageError("The saved gateway credentials are unavailable."); }
  return readEndpointUsage(usage, credentials, deps);
}
