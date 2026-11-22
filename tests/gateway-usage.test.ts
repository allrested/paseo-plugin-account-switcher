import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSchema, BDDEV_USAGE, GatewayUsageSchema, UsageSnapshotSchema, type GatewayUsage } from "../shared/contracts";
import { GatewayUsageError, readEndpointUsage, readFileUsage, readGatewayUsage } from "../server/usage/gateway";

type Endpoint = Extract<GatewayUsage, { kind: "endpoint" }>;
const TOKEN = "T0KEN-secret-fixture";
const bddev = BDDEV_USAGE as Endpoint;
const fixture = new URL("./fixtures/bddev-usage.json", import.meta.url);
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
const endpoint = (fields: Endpoint["fields"], extra: Partial<Endpoint> = {}): Endpoint =>
  GatewayUsageSchema.parse({ kind: "endpoint", path: "/usage", fields, unit: "credits", ...extra }) as Endpoint;
const read = (usage: Endpoint, response: Response | (() => Promise<Response>), baseUrl = "https://gw.example") => {
  const fetch = vi.fn(typeof response === "function" ? response : async () => response);
  return { fetch, result: readEndpointUsage(usage, { baseUrl, token: TOKEN }, { fetch: fetch as unknown as typeof globalThis.fetch }) };
};

describe("usage endpoint", () => {
  it("reads BDDev's reply with the ready values", async () => {
    const { fetch, result } = read(bddev, new Response(await readFile(fixture, "utf8")), "https://api.bddevlab.online");
    expect(await result).toEqual({ plan: "Team", windows: [], balances: [
      { id: "balance", label: "Credits", used: 588, remaining: 412, limit: 1000, unit: "credits", detail: null }] });
    expect(fetch).toHaveBeenCalledWith("https://api.bddevlab.online/api/usage/token/", expect.objectContaining({
      method: "GET", redirect: "error", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } }));
  });
  it("keeps the request on the gateway's origin", async () => {
    const { fetch, result } = read(endpoint({ used: "u" }, { path: "/usage?x=1" }), json({ u: 1 }), "https://gw.example/anthropic/v1");
    await result;
    expect(fetch).toHaveBeenCalledWith("https://gw.example/usage?x=1", expect.anything());
  });
  it("works out a missing third amount", async () => {
    expect((await read(endpoint({ used: "u", limit: "l" }), json({ u: 30, l: 100 })).result).balances[0]).toMatchObject({ used: 30, limit: 100, remaining: 70 });
    expect((await read(endpoint({ used: "u", remaining: "r" }), json({ u: 30, r: 70 })).result).balances[0]).toMatchObject({ used: 30, limit: 100, remaining: 70 });
    expect((await read(endpoint({ limit: "l", remaining: "r" }), json({ l: 100, r: 70 })).result).balances[0]).toMatchObject({ used: 30, limit: 100, remaining: 70 });
  });
  it("accepts numeric strings and array segments, and applies the divisor", async () => {
    const usage = endpoint({ remaining: "items.0.left" }, { divisor: 100000 });
    expect((await read(usage, json({ items: [{ left: "41200000" }] })).result).balances[0]).toMatchObject({ remaining: 412, used: null, limit: null });
  });
  it("turns a percent and a reset time into a window", async () => {
    const usage = endpoint({ usedPercent: "p", resetsAt: "r" }, { label: "Weekly" });
    const iso = "2026-11-23T08:53:20.000Z";
    for (const r of [iso, 1795424000, 1795424000000]) {
      expect(await read(usage, json({ p: 42.5, r })).result).toEqual({ plan: null, balances: [],
        windows: [{ id: "window", label: "Weekly", usedPercent: 42.5, windowDurationMins: null, resetsAt: iso }] });
    }
  });
  it("shows an unlimited balance without a limit", async () => {
    const usage = endpoint({ used: "u", limit: "l", unlimited: "free" });
    expect((await read(usage, json({ u: 10, l: 0, free: true })).result).balances).toEqual([
      { id: "balance", label: "Balance", used: 10, remaining: null, limit: null, unit: "credits", detail: "Unlimited" }]);
  });
  it("treats a limit of 0 as no limit", async () => {
    expect((await read(endpoint({ used: "u", limit: "l" }), json({ u: 5, l: 0 })).result).balances[0]).toMatchObject({ used: 5, limit: null, remaining: null });
  });
  it("names the field that holds no number", async () => {
    const usage = endpoint({ used: "data.total_used" });
    for (const body of [{}, { data: {} }, { data: { total_used: null } }, { data: { total_used: true } }, { data: { total_used: { a: 1 } } }, { data: { total_used: "abc" } }, { data: { total_used: "" } }])
      await expect(read(usage, json(body)).result).rejects.toThrow("The usage reply has no number at data.total_used.");
  });
  it("refuses a reply that is not JSON", async () => {
    await expect(read(endpoint({ used: "u" }), new Response("<html>secret-page-text</html>")).result).rejects.toThrow("The usage reply is not JSON.");
  });
  it("reports refused tokens and failed requests by status", async () => {
    const usage = endpoint({ used: "u" });
    await expect(read(usage, json({}, { status: 401 })).result).rejects.toThrow("The gateway refused the token (401).");
    await expect(read(usage, json({}, { status: 403 })).result).rejects.toThrow("The gateway refused the token (403).");
    await expect(read(usage, json({}, { status: 500 })).result).rejects.toThrow("The gateway's usage request failed (500).");
    await expect(read(usage, json({}, { status: 429, headers: { "retry-after": "30" } })).result).rejects.toMatchObject({ retryAfterMs: 30_000 });
    await expect(read(usage, async () => { throw new Error(`network ${TOKEN}`); }).result).rejects.toThrow("The gateway's usage request failed.");
  });
  it("refuses a reply over 256 KB", async () => {
    await expect(read(endpoint({ used: "u" }), new Response(JSON.stringify({ u: 1, pad: "x".repeat(300_000) }))).result).rejects.toThrow("The usage reply is too large.");
  });
  it("never puts the token or the reply's text in an error", async () => {
    const usage = endpoint({ used: "u" });
    const cases = [new Response("secret-page-text"), json({ u: "secret-page-text" }), json({ note: "secret-page-text" }, { status: 500 }), json({}, { status: 401 })];
    for (const response of cases) {
      const error = await read(usage, response).result.catch(e => e);
      expect(error).toBeInstanceOf(GatewayUsageError);
      expect(String(error.message)).not.toMatch(/secret-page-text|T0KEN/);
    }
  });
});

describe("external reading", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse("2026-11-22T06:00:00.000Z");
  const file = async (content: string) => { dir = await mkdtemp(join(tmpdir(), "gw-usage-")); const path = join(dir, "report.json"); await writeFile(path, content); return path; };
  const readAt = (path: string) => readFileUsage({ kind: "file", path }, { now: () => now });
  const report = (fetchedAt: string, body: unknown = { status: "available", planLabel: "Team A",
    windows: [{ id: "s", label: "Current session", usedPct: 40, resetsAt: "2026-11-22T08:00:00.000Z" }, { id: "w", label: "Weekly", remainingPct: 25 }],
    balances: [{ id: "today", label: "Today", used: 3.2, unit: "usd" }] }) => JSON.stringify({ fetchedAt, report: body });

  it("converts a Paseo usage report", async () => {
    const fetchedAt = "2026-11-22T05:55:00.000Z";
    expect(await readAt(await file(report(fetchedAt)))).toEqual({ plan: "Team A", fetchedAt,
      windows: [{ id: "s", label: "Current session", usedPercent: 40, windowDurationMins: null, resetsAt: "2026-11-22T08:00:00.000Z" },
        { id: "w", label: "Weekly", usedPercent: 75, windowDurationMins: null, resetsAt: null }],
      balances: [{ id: "today", label: "Today", used: 3.2, remaining: null, limit: null, unit: "usd", detail: null }] });
  });
  it("gives a plain reason for a file it cannot use", async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-usage-"));
    await expect(readAt(join(dir, "none.json"))).rejects.toThrow("The usage file is missing.");
    await mkdir(join(dir, "d"));
    await expect(readAt(join(dir, "d"))).rejects.toThrow("The usage file is not a regular file.");
    await writeFile(join(dir, "real.json"), report("2026-11-22T05:55:00.000Z"));
    await symlink(join(dir, "real.json"), join(dir, "link.json"));
    await expect(readAt(join(dir, "link.json"))).rejects.toThrow("The usage file is not a regular file.");
    await writeFile(join(dir, "big.json"), "x".repeat(300_000));
    await expect(readAt(join(dir, "big.json"))).rejects.toThrow("The usage file is too large.");
    await writeFile(join(dir, "half.json"), '{"fetchedAt":"2026-11-22T05:55:00.000Z","report":{"status":"avail');
    await expect(readAt(join(dir, "half.json"))).rejects.toThrow("The usage file is not a usage report.");
    await writeFile(join(dir, "shape.json"), JSON.stringify({ report: { status: "available" } }));
    await expect(readAt(join(dir, "shape.json"))).rejects.toThrow("The usage file is not a usage report.");
    await writeFile(join(dir, "err.json"), report("2026-11-22T05:55:00.000Z", { status: "error", error: "secret-page-text" }));
    await expect(readAt(join(dir, "err.json"))).rejects.toThrow("The usage file reports no usage.");
  });
  it("marks a reading older than 30 minutes as stale", async () => {
    await expect(readAt(await file(report("2026-11-22T05:29:00.000Z")))).rejects.toMatchObject({ stale: true, message: "The usage file is older than 30 minutes." });
  });
  it("asks for the gateway's credentials only for an endpoint", async () => {
    const credentials = vi.fn(async () => ({ baseUrl: "https://gw.example", token: TOKEN }));
    await readGatewayUsage({ kind: "file", path: await file(report("2026-11-22T05:55:00.000Z")) }, credentials, { now: () => now });
    expect(credentials).not.toHaveBeenCalled();
    const fetch = vi.fn(async () => json({ u: 1 }));
    await readGatewayUsage(endpoint({ used: "u" }), credentials, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(credentials).toHaveBeenCalledTimes(1);
  });
});

describe("usage setting shape", () => {
  const base = { kind: "endpoint", path: "/u", fields: { used: "a" }, unit: "credits" };
  it("accepts the BDDev values and fills defaults", () => {
    expect(GatewayUsageSchema.parse(BDDEV_USAGE)).toEqual(BDDEV_USAGE);
    expect(GatewayUsageSchema.parse(base)).toMatchObject({ divisor: 1, label: "Balance" });
  });
  it.each([
    ["a full address", { ...base, path: "https://evil.example/x" }],
    ["a protocol-relative address", { ...base, path: "//evil.example/x" }],
    ["a backslash", { ...base, path: "/\\evil.example" }],
    ["a fragment", { ...base, path: "/u#x" }],
    ["an empty segment", { ...base, fields: { used: "a..b" } }],
    ["a bracket path", { ...base, fields: { used: "a[0]" } }],
    ["no amount field", { ...base, fields: { plan: "name" } }],
    ["a zero divisor", { ...base, divisor: 0 }],
    ["a relative file", { kind: "file", path: "report.json" }],
  ])("refuses %s", (_, value) => { expect(GatewayUsageSchema.safeParse(value).success).toBe(false); });
  it("keeps older snapshots and accounts readable", () => {
    expect(UsageSnapshotSchema.parse({ accountId: "a", provider: "claude", status: "ok", plan: null, windows: [], fetchedAt: null, checkedAt: "x", nextRetryAt: null, error: null }).balances).toBeUndefined();
    expect(AccountSchema.parse({ id: "a", provider: "claude", label: "G", source: "gateway", email: null, plan: null, authStatus: "ready", createdAt: "x" }).usage).toBeUndefined();
  });
});
