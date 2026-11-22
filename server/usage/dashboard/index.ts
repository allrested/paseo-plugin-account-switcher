import type { GatewayUsage } from "../../../shared/contracts";
import { GatewayUsageError, type GatewayReading } from "../gateway-reading";
import { cdpTabOpener, type OpenTab } from "./cdp";
import { loadPageText, SIGN_IN_NEEDED } from "./pages";
import { extractReadings, pageLines } from "./rules";

type Dashboard = Extract<GatewayUsage, { kind: "dashboard" }>;
export type DashboardReading = GatewayReading & { lines?: string[][] };
export type DashboardDependencies = { openTab?: (host: string, port: number) => OpenTab; now?: () => Date; sleep?: (ms: number) => Promise<void>; force?: boolean };
/** A caption was not on the page. `partial` holds what the other rules found and the page text, for the form's Test. */
export class DashboardMissingError extends GatewayUsageError {
  constructor(find: string, readonly partial: DashboardReading) { super(`No line '${find}' on the page.`); this.name = "DashboardMissingError"; }
}

const MAX_LINES = 300;
const GAP_MS = 60_000;
// The last read per account, so a list that polls every few seconds does not open a browser tab each time.
const last = new Map<string, { at: number; key: string; result: Promise<DashboardReading> }>();
export function resetDashboardGap(): void { last.clear(); }

async function read(usage: Dashboard, deps: DashboardDependencies): Promise<DashboardReading> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const unreachable = new GatewayUsageError(`The browser is unreachable at ${usage.browser.host}:${usage.browser.port}.`);
  let tab;
  try { tab = await (deps.openTab ?? cdpTabOpener)(usage.browser.host, usage.browser.port)(); } catch { throw unreachable; }
  try {
    const reading: DashboardReading = { plan: null, windows: [], balances: [], lines: [] };
    const missing: string[] = [];
    for (const [index, url] of usage.pages.entries()) {
      let text: string;
      try { text = await loadPageText(tab, url, { accountTile: usage.accountTile, sleep }); }
      catch (error) {
        // Only the two reasons written for the user leave this module; a browser's own error text stays here.
        const message = error instanceof Error ? error.message : "";
        throw new GatewayUsageError(message === SIGN_IN_NEEDED || message === "The dashboard page did not load." ? message : "The dashboard page could not be read.");
      }
      const lines = pageLines(text, usage.between?.[index]);
      const found = extractReadings(lines, usage.readings.filter(rule => (rule.page ?? 0) === index), now());
      reading.windows.push(...found.windows); reading.balances.push(...found.balances); missing.push(...found.missing);
      reading.lines!.push(lines.slice(0, MAX_LINES));
    }
    if (missing.length) throw new DashboardMissingError(missing[0], reading);
    return reading;
  } finally { await tab.close().catch(() => {}); }
}

/** Reads a gateway's usage from its dashboard pages, in a browser that is already signed in. The gateway's token is not involved. */
export function readDashboardUsage(accountId: string, usage: Dashboard, deps: DashboardDependencies = {}): Promise<DashboardReading> {
  const at = (deps.now ?? (() => new Date()))().getTime(), key = JSON.stringify(usage);
  const previous = last.get(accountId);
  if (!deps.force && previous && previous.key === key && at - previous.at < GAP_MS) return previous.result;
  const result = read(usage, deps);
  result.catch(() => {});
  last.set(accountId, { at, key, result });
  return result;
}
