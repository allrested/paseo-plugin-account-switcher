import type { GatewayUsage } from "../../../shared/contracts";
import { GatewayUsageError, type GatewayReading } from "../gateway-reading";
import { cdpTabOpener, type OpenTab } from "./cdp";
import { BODY_TEXT, loadPageText, SIGN_IN_NEEDED } from "./pages";
import { extractReadings, pageLines } from "./rules";

type Dashboard = Extract<GatewayUsage, { kind: "dashboard" }>;
export type DashboardReading = GatewayReading & { lines?: string[][] };
export type DashboardDependencies = { openTab?: (host: string, port: number) => OpenTab; now?: () => Date; sleep?: (ms: number) => Promise<void>; force?: boolean; signal?: AbortSignal };
/** A caption was not on the page. `partial` holds what the other rules found and the page text, for the form's Test. */
export class DashboardMissingError extends GatewayUsageError {
  constructor(find: string, readonly partial: DashboardReading) { super(`No line '${find}' on the page.`); this.name = "DashboardMissingError"; }
}

const MAX_LINES = 300;
const GAP_MS = 60_000;
// One read holds one of the scheduler's two slots, so it has a hard end.
const DEADLINE_MS = 45_000;
const STOPPED = "The dashboard read was stopped.";
// A page that fills in after it loads: how often its text is read again while a caption is still missing.
const CAPTION_ATTEMPTS = 10, CAPTION_POLL_MS = 500;
// The last read per account, so a list that polls every few seconds does not open a browser tab each time.
const last = new Map<string, { at: number; key: string; result: Promise<DashboardReading> }>();
export function resetDashboardGap(): void { last.clear(); }

async function read(usage: Dashboard, deps: DashboardDependencies): Promise<DashboardReading> {
  const now = deps.now ?? (() => new Date());
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const started = now().getTime();
  const guard = () => {
    if (deps.signal?.aborted) throw new GatewayUsageError(STOPPED);
    if (now().getTime() - started > DEADLINE_MS) throw new GatewayUsageError("The dashboard took too long to read.");
  };
  const sleep = async (ms: number) => { guard(); await wait(ms); guard(); };
  const unreachable = new GatewayUsageError(`The browser is unreachable at ${usage.browser.host}:${usage.browser.port}.`);
  let tab;
  try { tab = await (deps.openTab ?? cdpTabOpener)(usage.browser.host, usage.browser.port)(); } catch { throw unreachable; }
  try {
    const reading: DashboardReading = { plan: null, windows: [], balances: [], lines: [] };
    const missing: string[] = [];
    for (const [index, url] of usage.pages.entries()) {
      let text: string;
      try { guard(); text = await loadPageText(tab, url, { accountTile: usage.accountTile, sleep }); }
      catch (error) {
        if (error instanceof GatewayUsageError) throw error;
        // Only the two reasons written for the user leave this module; a browser's own error text stays here.
        const message = error instanceof Error ? error.message : "";
        throw new GatewayUsageError(message === SIGN_IN_NEEDED || message === "The dashboard page did not load." ? message : "The dashboard page could not be read.");
      }
      const rules = usage.readings.filter(rule => (rule.page ?? 0) === index);
      let lines = pageLines(text, usage.between?.[index]);
      let found = extractReadings(lines, rules, now());
      for (let attempt = 1; found.missing.length && attempt < CAPTION_ATTEMPTS; attempt++) {
        await sleep(CAPTION_POLL_MS);
        try { text = String(await tab.evaluate(BODY_TEXT)); } catch { throw new GatewayUsageError("The dashboard page could not be read."); }
        lines = pageLines(text, usage.between?.[index]);
        found = extractReadings(lines, rules, now());
      }
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
  last.set(accountId, { at, key, result });
  // A read the scheduler stopped says nothing about the dashboard: it is not repeated from memory.
  result.catch(error => { if (error instanceof GatewayUsageError && error.message === STOPPED && last.get(accountId)?.result === result) last.delete(accountId); });
  return result;
}
