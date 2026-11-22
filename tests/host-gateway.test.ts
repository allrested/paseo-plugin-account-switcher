import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AccountStore } from "../server/store";
import { gatewayCredentials, reconcileHostGateway, setGatewayUsage, testGatewayUsage } from "../server/claude-profiles";
import { prepareProfile, stripAuthSettings } from "../server/profiles";
import { discoverAccounts } from "../server/paseo-usage";
import { BDDEV_USAGE, isGateway, isHostGateway, type Account } from "../shared/contracts";
import { accountStatus } from "../client/format";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
const TOKEN = "only-a-test-bearer";
async function host(settings: unknown) {
  const home = await mkdtemp(join(tmpdir(), "host-gateway-")); roots.push(home);
  const claude = join(home, ".claude");
  await mkdir(claude, { recursive: true });
  if (settings !== undefined) await writeFile(join(claude, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  const store = new AccountStore(join(home, "plugin"));
  await store.initialize({ claude, codex: join(home, ".codex") });
  await store.change(s => { s.available.claude = true; });
  return { home, claude, store, system: async () => (await store.read()).accounts.find(a => a.id === "system-claude")! };
}
const proxy = (extra: Record<string, unknown> = {}) => ({ theme: "dark", env: { ANTHROPIC_BASE_URL: "https://proxy.example/", ANTHROPIC_AUTH_TOKEN: TOKEN, ENABLE_TOOL_SEARCH: "true", ...extra } });

it("recognises a host whose Claude settings point at a gateway, and forgets it when they no longer do", async () => {
  const { claude, store, system } = await host(proxy());
  expect(await system()).toMatchObject({ authStatus: "unknown" });
  expect(isGateway(await system())).toBe(false);
  await reconcileHostGateway(store);
  expect(await system()).toMatchObject({ source: "system", baseUrl: "https://proxy.example", authStatus: "ready" });
  expect(isGateway(await system())).toBe(true);
  expect(isHostGateway(await system())).toBe(true);
  expect(await readFile(join(store.root, "registry.json"), "utf8")).not.toContain(TOKEN);
  expect(JSON.stringify(await store.snapshot())).not.toContain(TOKEN);
  await writeFile(join(claude, "settings.json"), JSON.stringify({ theme: "dark" }));
  await reconcileHostGateway(store);
  expect((await system()).baseUrl).toBeUndefined();
  expect(await system()).toMatchObject({ authStatus: "unknown" });
});
it.each([
  ["an API key", { env: { ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_API_KEY: "k" } }, true],
  ["a key helper", { apiKeyHelper: "/bin/key", env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }, true],
  ["a base URL without any credential", { env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }, false],
  ["a token without a base URL", { env: { ANTHROPIC_AUTH_TOKEN: "t" } }, false],
  ["an address that is not http", { env: { ANTHROPIC_BASE_URL: "file:///etc/passwd", ANTHROPIC_AUTH_TOKEN: "t" } }, false],
  ["settings that are not JSON", "not json", false],
  ["no settings file", undefined, false],
])("treats %s accordingly", async (_, settings, gateway) => {
  const { store, system } = await host(settings);
  await reconcileHostGateway(store);
  expect(isGateway(await system())).toBe(gateway);
});
it("does not keep credentials or a query in the address it shows", async () => {
  const { store, system } = await host({ env: { ANTHROPIC_BASE_URL: "https://user:secret@proxy.example/v1/?key=secret", ANTHROPIC_AUTH_TOKEN: TOKEN } });
  await reconcileHostGateway(store);
  expect((await system()).baseUrl).toBe("https://proxy.example/v1");
});
it("leaves a signed-in host account alone", async () => {
  const { store, system } = await host({ theme: "dark" });
  await store.change(s => { s.accounts.find(a => a.id === "system-claude")!.authStatus = "ready"; });
  await reconcileHostGateway(store);
  expect(await system()).toMatchObject({ authStatus: "ready" });
  expect((await system()).baseUrl).toBeUndefined();
});

it("copies the host's settings to another profile without the gateway", async () => {
  const { home, claude } = await host(proxy({ ANTHROPIC_API_KEY: "k", ANTHROPIC_CUSTOM_HEADERS: "x: y", CLAUDE_CONFIG_DIR: "/elsewhere" }));
  await writeFile(join(claude, "settings.json"), JSON.stringify({ ...proxy({ ANTHROPIC_API_KEY: "k", ANTHROPIC_CUSTOM_HEADERS: "x: y", CLAUDE_CONFIG_DIR: "/elsewhere" }), apiKeyHelper: "/bin/key" }));
  const target = join(home, "plugin", "accounts", "a", "claude");
  await prepareProfile({ provider: "claude", home: target, sourceHome: claude, sourceEnvironment: {} });
  const copied = JSON.parse(await readFile(join(target, "settings.json"), "utf8"));
  expect(copied).toEqual({ theme: "dark", env: { ENABLE_TOOL_SEARCH: "true" } });
  expect(JSON.parse(await readFile(join(claude, "settings.json"), "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
});
it("strips only authentication from settings", () => {
  expect(stripAuthSettings({ env: { ANTHROPIC_BASE_URL: "x", FOO: "1" }, hooks: {} })).toEqual({ env: { FOO: "1" }, hooks: {} });
  expect(stripAuthSettings({ env: { ANTHROPIC_AUTH_TOKEN: "x" } })).toEqual({});
  expect(stripAuthSettings({ theme: "dark" })).toEqual({ theme: "dark" });
});

it("reads usage for the host gateway with the token from its settings", async () => {
  const seen: unknown[] = [];
  const http = createServer((req, res) => { seen.push([req.url, req.headers.authorization]); res.end(JSON.stringify({ data: { name: "Team", total_granted: 100000000, total_used: 58800000, total_available: 41200000 } })); });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
  const address = http.address(); if (!address || typeof address === "string") throw Error("No port");
  try {
    const { store, system } = await host({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/v1`, ANTHROPIC_AUTH_TOKEN: TOKEN } });
    await expect(setGatewayUsage(store, "system-claude", BDDEV_USAGE)).rejects.toThrow("Choose a Claude gateway.");
    await reconcileHostGateway(store);
    expect(await gatewayCredentials(store, await system())).toEqual({ baseUrl: `http://127.0.0.1:${address.port}/v1`, token: TOKEN });
    const tested = await testGatewayUsage(store, "system-claude", BDDEV_USAGE);
    expect(tested).toMatchObject({ ok: true, balances: [{ remaining: 412 }] });
    expect(seen).toEqual([["/api/usage/token/", `Bearer ${TOKEN}`]]);
    expect(JSON.stringify(tested)).not.toContain(TOKEN);
    await setGatewayUsage(store, "system-claude", BDDEV_USAGE);
    expect((await system()).usage).toEqual(BDDEV_USAGE);
    expect(discoverAccounts(await store.read(), { kind: "global" })).toContainEqual({ key: hashAccountKey("gateway:system-claude"), label: "Current CLI · Claude", harness: "Claude Code", input: { accountId: "system-claude" } });
  } finally { await new Promise(done => http.close(done)); }
});
it("reports unavailable credentials when the host gateway has no bearer token", async () => {
  const { store, system } = await host({ apiKeyHelper: "/bin/key", env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });
  await reconcileHostGateway(store);
  await expect(gatewayCredentials(store, await system())).rejects.toThrow("The saved gateway credentials are unavailable.");
  expect(await testGatewayUsage(store, "system-claude", BDDEV_USAGE)).toMatchObject({ ok: false, error: "The saved gateway credentials are unavailable." });
});

it("describes the host gateway on its card", () => {
  const account = { id: "system-claude", provider: "claude", source: "system", label: "Current CLI · Claude", baseUrl: "https://proxy.example", email: null, plan: null, authStatus: "ready", createdAt: "x" } as Account;
  expect(accountStatus(account, undefined)).toEqual({ text: "Gateway from Claude settings", tone: "muted" });
  expect(accountStatus({ ...account, baseUrl: undefined }, undefined).text).toBe("sign-in confirmed");
});
