import { describe, expect, it } from "vitest";
import { balancePercent, formatBalance } from "../client/format";
import type { UsageBalance } from "../shared/contracts";

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
