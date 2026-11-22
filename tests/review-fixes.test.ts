import { constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTab, pageState } from "./helpers/fake-tab";
import { GatewayUsageSchema, type GatewayUsage } from "../shared/contracts";

const fsCalls = vi.hoisted(() => ({ readFile: [] as unknown[], open: [] as unknown[][] }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => { fsCalls.readFile.push(args[0]); return actual.readFile(...args); },
    open: (...args: Parameters<typeof actual.open>) => { fsCalls.open.push(args); return actual.open(...args); } };
});
const { extractReadings, parseValue } = await import("../server/usage/dashboard/rules");
const { BODY_TEXT, READ_STATE, clickAccountExpression } = await import("../server/usage/dashboard/pages");
const { readDashboardUsage, resetDashboardGap } = await import("../server/usage/dashboard");
const { readFileUsage } = await import("../server/usage/gateway");

type Dashboard = Extract<GatewayUsage, { kind: "dashboard" }>;
const now = new Date("2026-11-22T00:00:00.000Z");
const PAGE = "https://gateway.example/dashboard";
const setting = (extra: Partial<Dashboard> = {}): Dashboard => GatewayUsageSchema.parse({ kind: "dashboard", browser: { host: "browser.example", port: 9222 }, pages: [PAGE],
  readings: [{ label: "Cost", find: "EST. COST", type: "amount", unit: "usd" }], ...extra }) as Dashboard;
beforeEach(() => resetDashboardGap());

describe("a caption without a value", () => {
  it("does not take the next caption's number", () => {
    const out = extractReadings(["Session", "No data", "Weekly", "40%"], [{ label: "Session", find: "Session", type: "percent" }, { label: "Weekly", find: "Weekly", type: "percent" }], now);
    expect(out.windows).toEqual([{ id: "weekly", label: "Weekly", usedPercent: 40, windowDurationMins: null, resetsAt: null }]);
    expect(out.missing).toEqual(["Session"]);
  });
  it("stops at its own next occurrence too", () => {
    const out = extractReadings(["Quota", "n/a", "Quota", "20%"], [{ label: "Q", find: "Quota", type: "percent" }], now);
    expect(out.windows.map(w => w.usedPercent)).toEqual([20]);
  });
});

describe("numbers and reset times that only look right", () => {
  it.each(["5 m", "2.2M%", "1,5", "12,34", "1,2345"])("does not read %j", text => { expect(parseValue(text)).toBeNull(); });
  it.each([["1,234", 1234], ["12,345,678", 12345678], ["1234567", 1234567], ["2.2M", 2200000]])("still reads %s", (text, value) => { expect(parseValue(text)?.value).toBe(value); });
  it("does not read months or hours-in-words as minutes", () => {
    const rule = [{ label: "A", find: "A", type: "percent" as const }];
    expect(extractReadings(["A", "5%", "resets in 3 months"], rule, now).windows[0].resetsAt).toBeNull();
    expect(extractReadings(["A", "5%", "resets in 2h 5m"], rule, now).windows[0].resetsAt).toBe("2026-11-22T02:05:00.000Z");
  });
});

describe("the account tile click", () => {
  const run = (texts: string[], wanted: string) => {
    const nodes = texts.map(innerText => ({ innerText, click: vi.fn() }));
    const clicked = new Function("document", `return ${clickAccountExpression(wanted)}`)({ querySelectorAll: () => nodes });
    return { clicked, hits: nodes.map(n => n.click.mock.calls.length) };
  };
  it("prefers the element whose text is exactly the account", () => {
    expect(run(["Accounts viewer@example.com Remove other@example.com", "Remove viewer@example.com", " viewer@example.com "], "viewer@example.com")).toEqual({ clicked: true, hits: [0, 0, 1] });
  });
  it("otherwise takes the smallest element that shows it, not a wrapper", () => {
    expect(run(["Pick an account Viewer viewer@example.com Signed in Other other@example.com", "Viewer viewer@example.com Signed in"], "viewer@example.com")).toEqual({ clicked: true, hits: [0, 1] });
  });
  it("clicks nothing when no element shows it", () => {
    expect(run(["other@example.com"], "viewer@example.com")).toEqual({ clicked: false, hits: [0] });
  });
});

describe("a dashboard read that must stop", () => {
  it("stops when the scheduler aborts it, and closes the tab", async () => {
    const controller = new AbortController();
    const tab = new FakeTab((expr, t) => expr === READ_STATE ? pageState(t.url, "loading") : "");
    const sleep = vi.fn(async () => { controller.abort(); });
    await expect(readDashboardUsage("gw", setting(), { openTab: () => async () => tab, now: () => now, sleep, signal: controller.signal })).rejects.toThrow("The dashboard read was stopped.");
    expect(tab.closed).toBe(true);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("gives up after 45 seconds in total", async () => {
    let clock = now.getTime();
    const tab = new FakeTab((expr, t) => expr === READ_STATE ? pageState(t.url, "loading") : "");
    const sleep = vi.fn(async (ms: number) => { clock += ms * 40; });
    await expect(readDashboardUsage("gw", setting({ pages: [PAGE, PAGE + "/users", PAGE + "/more"] }), { openTab: () => async () => tab, now: () => new Date(clock), sleep })).rejects.toThrow("The dashboard took too long to read.");
    expect(tab.closed).toBe(true);
    expect(tab.calls.filter(c => c.startsWith("navigate"))).toHaveLength(1);
  });
});

describe("a page that fills in after it loads", () => {
  it("waits for the captions before reading the numbers", async () => {
    let bodies = 0;
    const tab = new FakeTab((expr, t) => expr === READ_STATE ? pageState(t.url) : expr === BODY_TEXT ? (++bodies < 3 ? "Usage\nLoading…" : "Usage\nEST. COST\n$38.20") : undefined);
    const reading = await readDashboardUsage("gw", setting(), { openTab: () => async () => tab, now: () => now, sleep: async () => {} });
    expect(reading.balances[0]).toMatchObject({ label: "Cost", used: 38.2 });
    expect(bodies).toBe(3);
  });
  it("still names the caption when it never appears", async () => {
    const tab = new FakeTab((expr, t) => expr === READ_STATE ? pageState(t.url) : "Usage\nLoading…");
    await expect(readDashboardUsage("gw", setting(), { openTab: () => async () => tab, now: () => now, sleep: async () => {} })).rejects.toThrow("No line 'EST. COST' on the page.");
    expect(tab.calls.filter(c => c === "body").length).toBeGreaterThan(1);
  });
});

describe("the external file is read through one bounded handle", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it("opens without following links and never reads by path", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-file-"));
    const path = join(dir, "report.json");
    await writeFile(path, JSON.stringify({ fetchedAt: now.toISOString(), report: { status: "available", windows: [], balances: [{ id: "t", label: "Today", used: 1, unit: "usd" }] } }));
    fsCalls.readFile.length = 0; fsCalls.open.length = 0;
    const reading = await readFileUsage({ kind: "file", path }, { now: () => now.getTime() });
    expect(reading.balances[0].used).toBe(1);
    expect(fsCalls.readFile).not.toContain(path);
    const opened = fsCalls.open.find(args => args[0] === path)!;
    expect(Number(opened[1]) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });
});
