import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTab, pageState } from "./helpers/fake-tab";
import { BODY_TEXT, READ_STATE } from "../server/usage/dashboard/pages";
import { DashboardMissingError, readDashboardUsage, resetDashboardGap } from "../server/usage/dashboard";
import { GatewayUsageError, readGatewayUsage } from "../server/usage/gateway";
import { GatewayUsageSchema, type GatewayUsage } from "../shared/contracts";

type Dashboard = Extract<GatewayUsage, { kind: "dashboard" }>;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/dashboard/${name}`, import.meta.url), "utf8");
const LIMITS = "https://gateway.example/dashboard", USAGE = "https://gateway.example/dashboard/users?range=today";
const setting = (extra: Partial<Dashboard> = {}): Dashboard => GatewayUsageSchema.parse({
  kind: "dashboard", browser: { host: "browser.example", port: 9222 }, pages: [LIMITS, USAGE], between: [{ after: "team-a", before: "team-b" }],
  readings: [{ label: "Weekly", find: "Weekly · all models", type: "percent" }, { label: "Cost", find: "EST. COST", type: "amount", unit: "usd", page: 1 }], ...extra }) as Dashboard;
const now = () => new Date("2026-11-22T00:00:00.000Z");
function browser() {
  const tabs: FakeTab[] = [];
  const openTab = vi.fn(async () => {
    const tab = new FakeTab((expr, t) => expr === READ_STATE ? pageState(t.url) : expr === BODY_TEXT ? fixture(t.url === LIMITS ? "limits.txt" : "usage.txt") : undefined);
    tabs.push(tab); return tab;
  });
  return { tabs, openTab };
}
const deps = (b: ReturnType<typeof browser>) => ({ openTab: () => b.openTab, now, sleep: async () => {} });
beforeEach(() => resetDashboardGap());

describe("usage dashboard", () => {
  it("gathers the readings of every page through one tab and closes it", async () => {
    const b = browser();
    const reading = await readDashboardUsage("gw", setting(), deps(b));
    expect(reading.windows.map(w => [w.label, w.usedPercent])).toEqual([["Weekly · one@example.com", 99], ["Weekly · two@example.com", 29]]);
    expect(reading.balances).toEqual([{ id: "cost", label: "Cost", used: 38.2, remaining: null, limit: null, unit: "usd", detail: null }]);
    expect(reading.plan).toBeNull();
    expect(b.tabs).toHaveLength(1);
    expect(b.tabs[0].calls.filter(c => c.startsWith("navigate"))).toEqual([`navigate ${LIMITS}`, `navigate ${USAGE}`]);
    expect(b.tabs[0].closed).toBe(true);
    expect(reading.lines).toHaveLength(2);
    expect(reading.lines![1]).toContain("EST. COST");
  });
  it("cuts the returned page text to 300 lines a page", async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\nEST. COST\n$1.00";
    const openTab = async () => new FakeTab((expr, t) => expr === READ_STATE ? pageState(t.url) : long);
    const reading = await readDashboardUsage("gw", setting({ pages: [USAGE], between: undefined, readings: [{ label: "Cost", find: "EST. COST", type: "amount", unit: "usd", page: 0 }] }), { openTab: () => openTab, now, sleep: async () => {} });
    expect(reading.lines![0]).toHaveLength(300);
    expect(reading.balances[0].used).toBe(1);
  });
  it("names the caption that is not on the page and keeps what it found", async () => {
    const b = browser();
    const usage = setting({ readings: [{ label: "Weekly", find: "Weekly · all models", type: "percent", page: 0 }, { label: "Gone", find: "NOT THERE", type: "percent", page: 1 }] });
    const error = await readDashboardUsage("gw", usage, deps(b)).catch(e => e);
    expect(error).toBeInstanceOf(DashboardMissingError);
    expect(error).toBeInstanceOf(GatewayUsageError);
    expect(error.message).toBe("No line 'NOT THERE' on the page.");
    expect(error.partial.windows).toHaveLength(2);
    expect(error.partial.lines).toHaveLength(2);
    expect(b.tabs[0].closed).toBe(true);
  });
  it("says so when the browser cannot be reached", async () => {
    const openTab = async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:9222"); };
    await expect(readDashboardUsage("gw", setting(), { openTab: () => openTab, now, sleep: async () => {} })).rejects.toThrow("The browser is unreachable at browser.example:9222.");
  });
  it("closes the tab when a page fails, and reports the sign-in", async () => {
    const tabs: FakeTab[] = [];
    const openTab = async () => { const tab = new FakeTab(expr => expr === READ_STATE ? pageState("https://login.example/x") : false); tabs.push(tab); return tab; };
    await expect(readDashboardUsage("gw", setting({ accountTile: undefined }), { openTab: () => openTab, now, sleep: async () => {} })).rejects.toThrow("Sign in to the dashboard in the shared browser.");
    expect(tabs[0].closed).toBe(true);
  });
  it("reads a dashboard at most once a minute for the same setting, unless asked to", async () => {
    const b = browser();
    let clock = Date.parse("2026-11-22T00:00:00.000Z");
    const d = { ...deps(b), now: () => new Date(clock) };
    const first = await readDashboardUsage("gw", setting(), d);
    clock += 59_000;
    expect(await readDashboardUsage("gw", setting(), d)).toBe(first);
    expect(b.openTab).toHaveBeenCalledTimes(1);
    await readDashboardUsage("gw", setting(), { ...d, force: true });
    expect(b.openTab).toHaveBeenCalledTimes(2);
    clock += 61_000;
    await readDashboardUsage("gw", setting(), d);
    expect(b.openTab).toHaveBeenCalledTimes(3);
    await readDashboardUsage("other", setting(), d);
    expect(b.openTab).toHaveBeenCalledTimes(4);
  });
  it("repeats a failure inside the minute without opening another tab", async () => {
    const openTab = vi.fn(async () => { throw new Error("down"); });
    const d = { openTab: () => openTab, now, sleep: async () => {} };
    await expect(readDashboardUsage("gw", setting(), d)).rejects.toThrow("The browser is unreachable");
    await expect(readDashboardUsage("gw", setting(), d)).rejects.toThrow("The browser is unreachable");
    expect(openTab).toHaveBeenCalledTimes(1);
  });
  it("never asks for the gateway's token", async () => {
    const b = browser(), credentials = vi.fn(async () => ({ baseUrl: "https://gateway.example", token: "fixture" }));
    const reading = await readGatewayUsage(setting(), credentials, { openTab: () => b.openTab, sleep: async () => {}, now: () => now().getTime(), accountId: "gw" });
    expect(credentials).not.toHaveBeenCalled();
    expect(reading.windows).toHaveLength(2);
  });
});

describe("usage dashboard setting", () => {
  const base = { kind: "dashboard", pages: ["https://gateway.example/dashboard"], readings: [{ label: "A", find: "A", type: "percent" }] };
  it("fills the shared browser's address by default", () => {
    expect(GatewayUsageSchema.parse(base)).toMatchObject({ browser: { host: "127.0.0.1", port: 9222 } });
  });
  it.each([
    ["an http page", { ...base, pages: ["http://gateway.example/dashboard"] }],
    ["a page with credentials", { ...base, pages: ["https://user:pass@gateway.example/"] }],
    ["an over-long page", { ...base, pages: ["https://gateway.example/" + "x".repeat(2048)] }],
    ["no page", { ...base, pages: [] }],
    ["five pages", { ...base, pages: Array(5).fill("https://gateway.example/") }],
    ["an amount without a unit", { ...base, readings: [{ label: "A", find: "A", type: "amount" }] }],
    ["thirteen readings", { ...base, readings: Array(13).fill({ label: "A", find: "A", type: "percent" }) }],
    ["no reading", { ...base, readings: [] }],
    ["a reading on a page that is not listed", { ...base, readings: [{ label: "A", find: "A", type: "percent", page: 1 }] }],
    ["a browser host with a path", { ...base, browser: { host: "browser.example/x", port: 9222 } }],
    ["a port out of range", { ...base, browser: { host: "browser.example", port: 70000 } }],
  ])("refuses %s", (_, value) => { expect(GatewayUsageSchema.safeParse(value).success).toBe(false); });
});
