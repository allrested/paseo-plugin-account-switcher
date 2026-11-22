import { BDDEV_USAGE, GatewayUsageSchema, type GatewayUsage, type UsageUnit } from "../shared/contracts";

export type ReadingForm = { label: string; find: string; type: "percent" | "amount"; unit: UsageUnit; page: number };
/** What the Usage form holds while it is edited: every value as the text the user typed. */
export type UsageForm = {
  kind: "off" | "endpoint" | "dashboard" | "file";
  path: string; used: string; limit: string; remaining: string; usedPercent: string; resetsAt: string; plan: string; unlimited: string;
  unit: UsageUnit; divisor: string; label: string; filePath: string;
  browserHost: string; browserPort: string; pages: string[]; accountTile: string; between: { after: string; before: string }[]; readings: ReadingForm[];
};
export const FIELD_NAMES = ["used", "limit", "remaining", "usedPercent", "resetsAt", "plan", "unlimited"] as const;
export const MAX_PAGES = 4, MAX_READINGS = 12;
export const emptyReading = (): ReadingForm => ({ label: "", find: "", type: "percent", unit: "credits", page: 0 });
const blank = (): UsageForm => ({
  kind: "off", path: "", used: "", limit: "", remaining: "", usedPercent: "", resetsAt: "", plan: "", unlimited: "", unit: "credits", divisor: "1", label: "Balance", filePath: "",
  browserHost: "127.0.0.1", browserPort: "9222", pages: [""], accountTile: "", between: [{ after: "", before: "" }], readings: [emptyReading()],
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
    readings: usage.readings.map(r => ({ label: r.label, find: r.find, type: r.type, unit: r.unit ?? "credits", page: r.page ?? 0 })) };
  const fields = Object.fromEntries(FIELD_NAMES.map(name => [name, usage.fields[name] ?? ""])) as Pick<UsageForm, typeof FIELD_NAMES[number]>;
  return { ...form, ...fields, kind: "endpoint", path: usage.path, unit: usage.unit, divisor: String(usage.divisor), label: usage.label };
}
export const bddevForm = (current: UsageForm): UsageForm => ({ ...current, ...formFromUsage(BDDEV_USAGE), browserHost: current.browserHost, browserPort: current.browserPort,
  pages: current.pages, accountTile: current.accountTile, between: current.between, readings: current.readings, filePath: current.filePath });

/** The setting the form describes, or the first reason it does not fit. `null` is Off. */
export function usageFromForm(form: UsageForm, baseUrl: string | undefined): { ok: true; usage: GatewayUsage | null } | { ok: false; error: string } {
  if (form.kind === "off") return { ok: true, usage: null };
  let candidate: unknown;
  if (form.kind === "file") candidate = { kind: "file", path: form.filePath.trim() };
  else if (form.kind === "dashboard") {
    const between = form.pages.map((_, index) => {
      const after = form.between[index]?.after.trim(), before = form.between[index]?.before.trim();
      return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
    });
    candidate = {
      kind: "dashboard", browser: { host: form.browserHost.trim(), port: Number(form.browserPort) }, pages: form.pages.map(page => page.trim()),
      ...(form.accountTile.trim() ? { accountTile: form.accountTile.trim() } : {}),
      ...(between.some(item => item.after || item.before) ? { between } : {}),
      readings: form.readings.map(r => ({ label: r.label, find: r.find, type: r.type, ...(r.type === "amount" ? { unit: r.unit } : {}), ...(r.page > 0 ? { page: r.page } : {}) })),
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
  const parsed = GatewayUsageSchema.safeParse(candidate);
  return parsed.success ? { ok: true, usage: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
}
