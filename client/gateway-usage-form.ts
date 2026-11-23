import { BDDEV_USAGE, GatewayUsageProbeSchema, GatewayUsageSchema, type GatewayUsage, type UsageUnit } from "../shared/contracts";

export type ReadingForm = { label: string; find: string; type: "percent" | "amount"; unit: UsageUnit; page: number };
/** What the Usage form holds while it is edited: every value as the text the user typed. */
export type UsageForm = {
  kind: "off" | "endpoint" | "dashboard" | "file";
  path: string; used: string; limit: string; remaining: string; usedPercent: string; resetsAt: string; plan: string; unlimited: string;
  unit: UsageUnit; divisor: string; label: string; filePath: string;
  browserHost: string; browserPort: string; pages: string[]; accountTile: string; between: { after: string; before: string }[]; readings: ReadingForm[];
  sessionId: string; sessionAccount: string; sessionPage: number;
};
export const FIELD_NAMES = ["used", "limit", "remaining", "usedPercent", "resetsAt", "plan", "unlimited"] as const;
export const MAX_PAGES = 4, MAX_READINGS = 12;
export const emptyReading = (): ReadingForm => ({ label: "", find: "", type: "percent", unit: "credits", page: 0 });
const blank = (): UsageForm => ({
  kind: "off", path: "", used: "", limit: "", remaining: "", usedPercent: "", resetsAt: "", plan: "", unlimited: "", unit: "credits", divisor: "1", label: "Balance", filePath: "",
  browserHost: "127.0.0.1", browserPort: "9222", pages: [""], accountTile: "", between: [{ after: "", before: "" }], readings: [emptyReading()], sessionId: "", sessionAccount: "", sessionPage: 0,
});

/** The form for a saved setting. Without one, the dashboard page starts as the gateway's own address. */
export function formFromUsage(usage: GatewayUsage | undefined, baseUrl?: string): UsageForm {
  const form = blank();
  if (!usage) {
    try { form.pages = [`${new URL(baseUrl ?? "").origin}/`]; } catch { /* no usable address: the page stays empty */ }
    return form;
  }
  if (usage.kind === "file") return { ...form, kind: "file", filePath: usage.path };
  if (usage.kind === "dashboard") return { ...form, kind: "dashboard", browserHost: usage.browser.host, browserPort: String(usage.browser.port), pages: [...usage.pages],
    accountTile: usage.accountTile ?? "", between: usage.pages.map((_, index) => ({ after: usage.between?.[index]?.after ?? "", before: usage.between?.[index]?.before ?? "" })),
    readings: usage.readings.map(r => ({ label: r.label, find: r.find, type: r.type, unit: r.unit ?? "credits", page: r.page ?? 0 })),
    sessionId: usage.sessions?.id ?? "", sessionAccount: usage.sessions?.account ?? "", sessionPage: usage.sessions?.page ?? 0 };
  const fields = Object.fromEntries(FIELD_NAMES.map(name => [name, usage.fields[name] ?? ""])) as Pick<UsageForm, typeof FIELD_NAMES[number]>;
  return { ...form, ...fields, kind: "endpoint", path: usage.path, unit: usage.unit, divisor: String(usage.divisor), label: usage.label };
}
export const bddevForm = (current: UsageForm): UsageForm => ({ ...current, ...formFromUsage(BDDEV_USAGE), browserHost: current.browserHost, browserPort: current.browserPort,
  pages: current.pages, accountTile: current.accountTile, between: current.between, readings: current.readings, filePath: current.filePath,
  sessionId: current.sessionId, sessionAccount: current.sessionAccount, sessionPage: current.sessionPage });

/**
 * The setting the form describes, or the first reason it does not fit. `null` is Off.
 * For "test", a dashboard's readings without a caption are left out: Test may run with none, to fetch the page text to pick captions from.
 */
export function usageFromForm(form: UsageForm, baseUrl: string | undefined, purpose: "save" | "test" = "save"): { ok: true; usage: GatewayUsage | null } | { ok: false; error: string } {
  if (form.kind === "off") return { ok: true, usage: null };
  let candidate: unknown;
  if (form.kind === "file") candidate = { kind: "file", path: form.filePath.trim() };
  else if (form.kind === "dashboard") {
    const port = Number(form.browserPort);
    if (!form.browserHost.trim()) return { ok: false, error: "Enter the browser’s host name or IP address." };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Enter the browser’s port, a number from 1 to 65535." };
    const badPage = form.pages.findIndex(page => { try { return new URL(page.trim()).protocol !== "https:"; } catch { return true; } });
    if (badPage !== -1) return { ok: false, error: `Page ${badPage + 1} needs an https address.` };
    const blank = form.readings.findIndex(reading => !reading.find.trim());
    if (purpose === "save" && blank !== -1) return { ok: false, error: `Enter a caption for reading ${blank + 1}. Press Test to see the page text and pick one.` };
    const sessionId = form.sessionId.trim(), sessionAccount = form.sessionAccount.trim();
    if (Boolean(sessionId) !== Boolean(sessionAccount)) return { ok: false, error: "To show a session’s account, enter both column headers of the sessions table." };
    const between = form.pages.map((_, index) => {
      const after = form.between[index]?.after.trim(), before = form.between[index]?.before.trim();
      return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
    });
    candidate = {
      kind: "dashboard", browser: { host: form.browserHost.trim(), port: Number(form.browserPort) }, pages: form.pages.map(page => page.trim()),
      ...(form.accountTile.trim() ? { accountTile: form.accountTile.trim() } : {}),
      ...(between.some(item => item.after || item.before) ? { between } : {}),
      // A reading with no name of its own is shown under its caption.
      readings: form.readings.filter(r => r.find.trim()).map(r => ({ label: r.label.trim() || r.find.trim().slice(0, 40), find: r.find, type: r.type, ...(r.type === "amount" ? { unit: r.unit } : {}), ...(r.page > 0 ? { page: r.page } : {}) })),
      ...(sessionId ? { sessions: { id: sessionId, account: sessionAccount, ...(form.sessionPage > 0 && form.sessionPage < form.pages.length ? { page: form.sessionPage } : {}) } } : {}),
    };
  } else {
    let path = form.path.trim();
    // A full address is welcome when it is the gateway's own; only its path is kept, so the token cannot be sent elsewhere.
    if (/^https?:\/\//i.test(path)) {
      try {
        const url = new URL(path), gateway = new URL(baseUrl ?? "");
        if (url.origin !== gateway.origin) return { ok: false, error: `The usage endpoint must be on the gateway (${gateway.host}).` };
        path = url.pathname + url.search;
      } catch { return { ok: false, error: "Enter the usage endpoint as a path, such as /api/usage." }; }
    }
    const fields = Object.fromEntries(FIELD_NAMES.map(name => [name, form[name].trim()]).filter(([, value]) => value));
    candidate = { kind: "endpoint", path, fields, unit: form.unit, divisor: Number(form.divisor), label: form.label };
  }
  const parsed = (purpose === "test" ? GatewayUsageProbeSchema : GatewayUsageSchema).safeParse(candidate);
  return parsed.success ? { ok: true, usage: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
}
