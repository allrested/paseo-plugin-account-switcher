import type { UsageBalance, UsageUnit, UsageWindow } from "../../../shared/contracts";

/** One reading to gather: the caption line to find on the page and what kind of number follows it. */
export type Rule = { label: string; find: string; type: "percent" | "amount"; unit?: UsageUnit; page?: number };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^\$?\s*(-?\d[\d,]*(?:\.\d+)?)\s*([KMB])?\s*(%)?$/i;
const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
const fold = (text: string) => text.trim().toLowerCase();

/** The page's non-empty lines, optionally only those between two lines of text. */
export function pageLines(text: string, between?: { after?: string; before?: string }): string[] {
  let lines = text.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  if (between?.after) {
    const start = lines.findIndex(line => fold(line) === fold(between.after!));
    lines = start === -1 ? [] : lines.slice(start + 1);
  }
  if (between?.before) {
    const end = lines.findIndex(line => fold(line) === fold(between.before!));
    if (end !== -1) lines = lines.slice(0, end);
  }
  return lines;
}

/** `99%`, `2,059`, `$1,234.50`, `26.7K`, `2.2M`. Anything else is not a value. */
export function parseValue(line: string): { value: number; percent: boolean } | null {
  const match = NUMBER.exec(line.trim());
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, "")) * (match[2] ? SCALE[match[2].toUpperCase()] : 1);
  return Number.isFinite(value) ? { value, percent: Boolean(match[3]) } : null;
}

function resetTime(lines: string[], now: Date): string | null {
  for (const line of lines) {
    const relative = /resets in ((?:\d+\s*[dhm]\s*)+)/i.exec(line);
    if (relative) {
      let ms = 0;
      for (const [, count, unit] of relative[1].matchAll(/(\d+)\s*([dhm])/gi)) ms += Number(count) * UNIT_MS[unit.toLowerCase()];
      return new Date(now.getTime() + ms).toISOString();
    }
    const absolute = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/.exec(line);
    if (absolute && Number.isFinite(Date.parse(absolute[0]))) return new Date(absolute[0]).toISOString();
  }
  return null;
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "reading";

/**
 * For each rule, every line equal to its caption and the first number of the right kind in the three lines after it.
 * A caption that occurs several times gives one reading per occurrence, named after the nearest email above it.
 */
export function extractReadings(lines: string[], rules: Rule[], now: Date): { windows: UsageWindow[]; balances: UsageBalance[]; missing: string[] } {
  const windows: UsageWindow[] = [], balances: UsageBalance[] = [], missing: string[] = [];
  for (const rule of rules) {
    const found: { value: number; at: number; owner: string | null }[] = [];
    lines.forEach((line, index) => {
      if (fold(line) !== fold(rule.find)) return;
      for (let offset = 1; offset <= 3; offset++) {
        const parsed = parseValue(lines[index + offset] ?? "");
        if (!parsed || parsed.percent !== (rule.type === "percent")) continue;
        let owner: string | null = null;
        for (let back = index - 1; back >= 0 && owner === null; back--) if (EMAIL.test(lines[back])) owner = lines[back];
        found.push({ value: parsed.value, at: index + offset, owner });
        return;
      }
    });
    if (!found.length) { missing.push(rule.find); continue; }
    const named = found.every(item => item.owner) && new Set(found.map(item => item.owner)).size === found.length;
    found.forEach((item, index) => {
      const many = found.length > 1;
      const id = many ? `${slug(rule.label)}-${index + 1}` : slug(rule.label);
      const label = many ? `${rule.label} · ${named ? item.owner : index + 1}` : rule.label;
      if (rule.type === "percent") windows.push({ id, label, usedPercent: item.value, windowDurationMins: null, resetsAt: resetTime(lines.slice(item.at + 1, item.at + 3), now) });
      else balances.push({ id, label, used: item.value, remaining: null, limit: null, unit: rule.unit ?? "credits", detail: null });
    });
  }
  return { windows, balances, missing };
}
