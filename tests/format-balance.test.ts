import { describe, expect, it } from "vitest";
import { balancePercent, formatBalance, usageSummary } from "../client/format";
import type { UsageBalance, UsageSnapshot } from "../shared/contracts";

const balance = (value: Partial<UsageBalance>): UsageBalance => ({ id: "b", label: "B", used: null, remaining: null, limit: null, unit: "credits", ...value });
describe("balance text", () => {
  it.each([
    [{ used: 588, remaining: 412, limit: 1000 }, "412 of 1,000 credits left"],
    [{ used: 38.2, unit: "usd" as const }, "$38.20 used"],
    [{ remaining: 12.5, unit: "usd" as const }, "$12.50 left"],
    [{ remaining: 12.5, limit: 50, unit: "usd" as const }, "$12.50 of $50.00 left"],
    [{ used: 1200, unit: "requests" as const }, "1,200 requests used"],
    [{ used: 2158984, unit: "tokens" as const }, "2,158,984 tokens used"],
    [{ used: 10.456 }, "10.46 credits used"],
    [{ used: 10, detail: "Unlimited" }, "10 credits used · Unlimited"],
    [{ detail: "Unlimited" }, "Unlimited"],
    [{ limit: 1000 }, "1,000 credits limit"],
    [{}, "no data"],
  ])("%j → %s", (value, text) => { expect(formatBalance(balance(value))).toBe(text); });
  it("gives a percent only with a real limit", () => {
    expect(balancePercent(balance({ used: 588, remaining: 412, limit: 1000 }))).toBe(58.8);
    expect(balancePercent(balance({ remaining: 250, limit: 1000 }))).toBe(75);
    expect(balancePercent(balance({ used: 5 }))).toBeNull();
    expect(balancePercent(balance({ used: 5, limit: 0 }))).toBeNull();
    expect(balancePercent(balance({ limit: 100 }))).toBeNull();
  });
});

describe("a gateway's one-line summary", () => {
  const snapshot = (value: Partial<UsageSnapshot>): UsageSnapshot => ({ accountId: "gw", provider: "claude", status: "ok", plan: null, windows: [], fetchedAt: null, checkedAt: "2026-11-22T00:00:00.000Z", nextRetryAt: null, error: null, ...value });
  it("shows the percent and the amount left when the gateway reports a limit", () => {
    expect(usageSummary(snapshot({ balances: [balance({ used: 15767.52537, remaining: 9300, limit: 25067.52537 })] }))).toBe("37.1% left · 9,300 credits");
    expect(usageSummary(snapshot({ balances: [balance({ used: 40, limit: 50, unit: "usd" })] }))).toBe("20% left · $10.00");
  });
  it("shows the amount alone without a limit", () => {
    expect(usageSummary(snapshot({ balances: [balance({ remaining: 12.5, unit: "usd" })] }))).toBe("$12.50 left");
    expect(usageSummary(snapshot({ balances: [balance({ used: 38.2, unit: "usd" })] }))).toBe("$38.20 used");
    expect(usageSummary(snapshot({ balances: [balance({ used: 10, detail: "Unlimited" })] }))).toBe("10 credits used · Unlimited");
  });
  it("prefers a percent window, as for a subscription", () => {
    expect(usageSummary(snapshot({ windows: [{ id: "w", label: "Weekly", usedPercent: 99, windowDurationMins: null, resetsAt: null }], balances: [balance({ used: 38.2, unit: "usd" })] }))).toBe("1% left");
  });
  it("marks a stale reading and keeps the plain words when there is nothing to show", () => {
    expect(usageSummary(snapshot({ status: "stale", balances: [balance({ remaining: 9300, limit: 25000 })] }))).toBe("37.2% left · 9,300 credits · stale");
    expect(usageSummary(snapshot({ status: "unavailable", balances: [] }))).toBe("limits unavailable");
    expect(usageSummary(snapshot({ balances: [] }))).toBe("limits —");
    expect(usageSummary(snapshot({ balances: [balance({})] }))).toBe("limits —");
  });
});
