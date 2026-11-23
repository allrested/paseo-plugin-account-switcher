import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractReadings, pageLines, parseValue, sessionAccounts } from "../server/usage/dashboard/rules";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/dashboard/${name}`, import.meta.url), "utf8");
const now = new Date("2026-11-22T00:00:00.000Z");
const weekly = { label: "Weekly", find: "weekly · all models", type: "percent" as const };

describe("dashboard page rules", () => {
  it("reads a repeated caption once per account, inside the chosen section", () => {
    const lines = pageLines(fixture("limits.txt"), { after: "team-a", before: "team-b" });
    expect(extractReadings(lines, [weekly], now)).toEqual({ balances: [], missing: [], windows: [
      { id: "weekly-1", label: "Weekly · one@example.com", usedPercent: 99, windowDurationMins: null, resetsAt: "2026-11-23T18:00:00.000Z", owner: "one@example.com" },
      { id: "weekly-2", label: "Weekly · two@example.com", usedPercent: 29, windowDurationMins: null, resetsAt: "2026-11-25T19:00:00.000Z", owner: "two@example.com" }] });
  });
  it("keeps the plain name for a caption that occurs once", () => {
    const lines = pageLines(fixture("limits.txt"), { after: "team-b" });
    expect(extractReadings(lines, [weekly], now).windows).toEqual([
      { id: "weekly", label: "Weekly", usedPercent: 50, windowDurationMins: null, resetsAt: "2026-11-27T02:00:00.000Z" }]);
  });
  it("numbers repeated captions that have no email above them", () => {
    const out = extractReadings(["Quota", "10%", "Quota", "20%"], [{ label: "Q", find: "quota", type: "percent" }], now);
    expect(out.windows.map(w => [w.id, w.label, w.usedPercent, w.resetsAt])).toEqual([["q-1", "Q · 1", 10, null], ["q-2", "Q · 2", 20, null]]);
  });
  it("reads amounts with their units", () => {
    expect(extractReadings(pageLines(fixture("usage.txt")), [
      { label: "Cost", find: "EST. COST", type: "amount", unit: "usd" },
      { label: "Requests", find: "REQUESTS", type: "amount", unit: "requests" },
      { label: "Output", find: "OUTPUT TOKENS", type: "amount", unit: "tokens" }], now).balances).toEqual([
      { id: "cost", label: "Cost", used: 38.2, remaining: null, limit: null, unit: "usd", detail: null },
      { id: "requests", label: "Requests", used: 2059, remaining: null, limit: null, unit: "requests", detail: null },
      { id: "output", label: "Output", used: 2200000, remaining: null, limit: null, unit: "tokens", detail: null }]);
  });
  it.each([["99%", 99, true], ["2,059", 2059, false], ["$1,234.50", 1234.5, false], ["26.7K", 26700, false], ["2.2M", 2200000, false], ["1.5B", 1500000000, false], ["0%", 0, true], ["12.5 %", 12.5, true]])(
    "reads %s", (text, value, percent) => { expect(parseValue(text)).toEqual({ value, percent }); });
  it.each(["just now", "1m ago", "12 accounts", "", "$", "1.2.3", "2026-11-22"])("does not read %j as a number", text => { expect(parseValue(text)).toBeNull(); });
  it("looks for the value in the next three lines only", () => {
    const rule = [{ label: "A", find: "A", type: "amount" as const, unit: "credits" as const }];
    expect(extractReadings(["A", "x", "y", "5"], rule, now).balances[0]?.used).toBe(5);
    expect(extractReadings(["A", "x", "y", "z", "5"], rule, now)).toMatchObject({ balances: [], missing: ["A"] });
  });
  it("matches the value's kind to the rule", () => {
    expect(extractReadings(["A", "5", "50%"], [{ label: "A", find: "A", type: "percent" }], now).windows[0]?.usedPercent).toBe(50);
    expect(extractReadings(["A", "50%", "5"], [{ label: "A", find: "A", type: "amount", unit: "credits" }], now).balances[0]?.used).toBe(5);
  });
  it("lists rules that found nothing and still returns the others", () => {
    const out = extractReadings(pageLines(fixture("usage.txt")), [
      { label: "Cost", find: "EST. COST", type: "amount", unit: "usd" }, { label: "Gone", find: "NOT THERE", type: "percent" }], now);
    expect(out.missing).toEqual(["NOT THERE"]);
    expect(out.balances).toHaveLength(1);
  });
  it("reads an ISO reset time, and leaves it empty without one", () => {
    const rule = [{ label: "A", find: "A", type: "percent" as const }];
    expect(extractReadings(["A", "5%", "resets 2026-12-01T00:00:00Z"], rule, now).windows[0].resetsAt).toBe("2026-12-01T00:00:00.000Z");
    expect(extractReadings(["A", "5%", "of the weekly limit"], rule, now).windows[0].resetsAt).toBeNull();
    expect(extractReadings(["A", "5%", "x", "y", "resets in 2h"], rule, now).windows[0].resetsAt).toBeNull();
    expect(extractReadings(["A", "5%", "resets in 45m"], rule, now).windows[0].resetsAt).toBe("2026-11-22T00:45:00.000Z");
  });
  it("returns no lines when the section's start is not on the page", () => {
    expect(pageLines("a\nb", { after: "missing" })).toEqual([]);
    expect(pageLines(" a \n\n b ")).toEqual(["a", "b"]);
  });
  it("reads the sessions table by its two column headers", () => {
    const table = "SESSIONS\n\n3\nSESSION ID\tMODEL\tACCOUNT\tREQUESTS\nee702cc2…\tOpus\tone@example.com\t12\nnot an id\tOpus\ttwo@example.com\t1\n582fedc7-aaaa\tHaiku\t two@example.com \t3\n0a1b2c3d…\tHaiku\t\t3\nData from the gateway\nffffffff…\tOpus\tone@example.com\t1";
    expect(sessionAccounts(table, { id: "session id", account: "Account" })).toEqual({ ee702cc2: "one@example.com", "582fedc7-aaaa": "two@example.com" });
    expect(sessionAccounts(table, { id: "Session", account: "Account" })).toEqual({});
    expect(sessionAccounts("REQUESTS\n\n12", { id: "SESSION ID", account: "ACCOUNT" })).toEqual({});
  });
});
