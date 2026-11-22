import { BDDEV_USAGE, GatewayUsageSchema, type GatewayUsage, type UsageUnit } from "../shared/contracts";

/** What the Usage form holds while it is edited: every value as the text the user typed. */
export type UsageForm = {
  kind: "off" | "endpoint" | "file";
  path: string; used: string; limit: string; remaining: string; usedPercent: string; resetsAt: string; plan: string; unlimited: string;
  unit: UsageUnit; divisor: string; label: string; filePath: string;
};
export const FIELD_NAMES = ["used", "limit", "remaining", "usedPercent", "resetsAt", "plan", "unlimited"] as const;
const blank: UsageForm = { kind: "off", path: "", used: "", limit: "", remaining: "", usedPercent: "", resetsAt: "", plan: "", unlimited: "", unit: "credits", divisor: "1", label: "Balance", filePath: "" };

export function formFromUsage(usage: GatewayUsage | undefined): UsageForm {
  if (!usage) return { ...blank };
  if (usage.kind === "file") return { ...blank, kind: "file", filePath: usage.path };
  const fields = Object.fromEntries(FIELD_NAMES.map(name => [name, usage.fields[name] ?? ""])) as Pick<UsageForm, typeof FIELD_NAMES[number]>;
  return { ...blank, ...fields, kind: "endpoint", path: usage.path, unit: usage.unit, divisor: String(usage.divisor), label: usage.label };
}
export const bddevForm = (): UsageForm => formFromUsage(BDDEV_USAGE);

/** The setting the form describes, or the first reason it does not fit. `null` is Off. */
export function usageFromForm(form: UsageForm, baseUrl: string | undefined): { ok: true; usage: GatewayUsage | null } | { ok: false; error: string } {
  if (form.kind === "off") return { ok: true, usage: null };
  let candidate: unknown;
  if (form.kind === "file") candidate = { kind: "file", path: form.filePath.trim() };
  else {
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
