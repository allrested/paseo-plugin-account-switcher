import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { AccountSchema, GatewayInput, GatewayUsageProbeSchema, GatewayUsageSchema, isGateway, isHostGateway, type GatewayUsage } from "../shared/contracts";
import { GatewayUsageError, readGatewayUsage, type GatewayDependencies } from "./usage/gateway";
import { DashboardMissingError, type DashboardReading } from "./usage/dashboard";
import { atomicWrite, isMissing } from "./files";
import { assertClaudeSettings, prepareProfile } from "./profiles";
import { accountFrom, type AccountStore, type Registry, type StoredAccount } from "./store";

const profileName = /^\.claude-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function validateLinkedProfile(path: string, userHome = homedir()): Promise<void> {
  if (dirname(path) !== userHome || !profileName.test(basename(path)) ||
      !(await lstat(path)).isDirectory() || await realpath(path) !== join(await realpath(userHome), basename(path))) {
    throw new Error("The linked Claude profile is unavailable.");
  }
  for (const file of ["settings.json", "settings.local.json"]) {
    try { assertClaudeSettings(JSON.parse(await readFile(join(path, file), "utf8"))); }
    catch (error) { if (!isMissing(error)) throw new Error("This profile has incompatible Claude settings."); }
  }
}

export function linkedCredentialHome(account: StoredAccount): string {
  if (account.source !== "linked" || account.provider !== "claude" || !account.credentialHome) throw new Error("Missing linked Claude credential directory.");
  return account.credentialHome;
}

function systemProfileHomes(state: Registry) {
  return [state.sourceHomes.claude, state.sourceEnvironment.claude.CLAUDE_SECURESTORAGE_CONFIG_DIR].filter((path): path is string => Boolean(path));
}

async function canonical(path: string) { return realpath(path).catch(() => path); }

export async function discoverProfiles(store: AccountStore, userHome = homedir()) {
  const state = await store.read();
  const known = new Set(await Promise.all([...systemProfileHomes(state), ...state.accounts.map(a => a.credentialHome ?? a.home)].map(canonical)));
  const found: string[] = [];
  for (const entry of await readdir(userHome, { withFileTypes: true })) {
    if (!entry.isDirectory() || !profileName.test(entry.name)) continue;
    const path = join(userHome, entry.name);
    if (known.has(await canonical(path))) continue;
    try { await validateLinkedProfile(path, userHome); found.push(entry.name); }
    catch { /* Only offer subscription-compatible profiles. */ }
  }
  return found.sort();
}

export async function linkProfile(store: AccountStore, name: string, userHome = homedir()) {
  if (!profileName.test(name)) throw new Error("Invalid Claude profile name.");
  const home = join(userHome, name);
  await validateLinkedProfile(home, userHome);
  return store.change(async state => {
    if (!state.available.claude) throw new Error("Claude Code is unavailable.");
    if ((await Promise.all(systemProfileHomes(state).map(canonical))).includes(await realpath(home))) throw new Error("The current CLI already uses this profile.");
    const existing = state.accounts.find(a => (a.credentialHome ?? a.home) === home);
    if (existing) return AccountSchema.parse(existing);
    const id = randomUUID(), launchHome = join(store.root, "accounts", id, "claude");
    try { await prepareProfile({ provider: "claude", home: launchHome, sourceHome: state.sourceHomes.claude, sourceEnvironment: state.sourceEnvironment.claude }); }
    catch (error) { await rm(dirname(launchHome), { recursive: true, force: true }); throw error; }
    const account: StoredAccount = { id, label: name.slice(8), provider: "claude", source: "linked", home: launchHome, credentialHome: home,
      authStatus: "unknown", createdAt: new Date().toISOString(), email: null, plan: null, loginToken: null, identityKey: null, generation: 0 };
    state.accounts.push(account);
    return AccountSchema.parse(account);
  });
}

export async function addGateway(store: AccountStore, input: { label: string; base_url: string; api_token: string }) {
  const { label, base_url, api_token } = GatewayInput.parse(input);
  const id = randomUUID();
  const dir = join(store.root, "accounts", id), home = join(dir, "claude");
  try {
    return await store.change(async state => {
      if (!state.available.claude) throw new Error("Claude Code is unavailable.");
      await mkdir(home, { recursive: true, mode: 0o700 });
      await prepareProfile({ provider: "claude", home, sourceHome: state.sourceHomes.claude, sourceEnvironment: state.sourceEnvironment.claude });
      await atomicWrite(join(dir, "gateway.json"), JSON.stringify({ base_url, api_token }));
      const account: StoredAccount = { id, provider: "claude", label, source: "gateway", home, baseUrl: base_url,
        authStatus: "ready", createdAt: new Date().toISOString(), email: null, plan: null, loginToken: null, identityKey: null, generation: 0 };
      state.accounts.push(account);
      return AccountSchema.parse(account);
    });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export async function gatewayEnvironment(root: string, account: StoredAccount) {
  try {
    if (account.source !== "gateway" || account.provider !== "claude" || !/^[a-zA-Z0-9_-]+$/.test(account.id)) throw new Error();
    const path = join(root, "accounts", account.id, "gateway.json");
    const stat = await lstat(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || await realpath(path) !== join(await realpath(root), "accounts", account.id, "gateway.json")) throw new Error();
    const saved = GatewayInput.parse({ ...JSON.parse(await readFile(path, "utf8")), label: account.label });
    if (saved.base_url !== account.baseUrl) throw new Error();
    return { ANTHROPIC_BASE_URL: saved.base_url, ANTHROPIC_AUTH_TOKEN: saved.api_token };
  } catch { throw new Error("The saved gateway credentials are unavailable."); }
}

export async function rotateGateway(store: AccountStore, accountId: string, token: string) {
  await store.change(async state => {
    const account = accountFrom(state, accountId);
    const { ANTHROPIC_BASE_URL: base_url } = await gatewayEnvironment(store.root, account);
    const api_token = GatewayInput.shape.api_token.parse(token);
    await atomicWrite(join(store.root, "accounts", account.id, "gateway.json"), JSON.stringify({ base_url, api_token }));
  });
}

// Pin the endpoint at CLI settings precedence. Preserve the SDK's settings and project
// permission rules. Only the endpoint is public; the bearer token stays out of argv.
export async function gatewayArguments(root: string, original: string[], endpoint: string) {
  const args = [...original];
  let last = -1, inline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings") { last = ++i; inline = false; }
    else if (args[i].startsWith("--settings=")) { last = i; inline = true; }
  }
  const env = { ANTHROPIC_BASE_URL: endpoint };
  if (last < 0) return { args: [...args, "--settings", JSON.stringify({ env })], file: undefined };
  const input = inline ? args[last].slice("--settings=".length) : args[last];
  const settings = JSON.parse(input.trimStart().startsWith("{") ? input : await readFile(input, "utf8"));
  assertClaudeSettings(settings);
  const file = join(root, "launch-settings", randomUUID() + ".json");
  await atomicWrite(file, JSON.stringify({ ...settings, env: { ...settings.env, ...env } }));
  args[last] = inline ? "--settings=" + file : file;
  return { args, file };
}

function gatewayFrom(state: { accounts: StoredAccount[] }, accountId: string): StoredAccount {
  const account = state.accounts.find(a => a.id === accountId);
  if (!account || !isGateway(account) || account.provider !== "claude") throw new Error("Choose a Claude gateway.");
  return account;
}

/**
 * The gateway the host's own Claude CLI is set up for: a base URL in the `env` of its settings.json, with a token, a key
 * or a key helper beside it. The token is returned for a usage request only; it is never stored by this plugin.
 */
async function readHostGateway(state: Pick<Registry, "sourceHomes">): Promise<{ baseUrl: string; token: string | null } | null> {
  let settings: unknown;
  try { settings = JSON.parse(await readFile(join(state.sourceHomes.claude, "settings.json"), "utf8")); } catch { return null; }
  if (!settings || typeof settings !== "object") return null;
  const { env, apiKeyHelper } = settings as { env?: Record<string, unknown>; apiKeyHelper?: unknown };
  const address = env?.ANTHROPIC_BASE_URL, token = env?.ANTHROPIC_AUTH_TOKEN;
  if (typeof address !== "string" || !(typeof token === "string" && token || typeof env?.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY || apiKeyHelper)) return null;
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Shown and stored without credentials or a query, which an address may carry.
    return { baseUrl: (url.origin + url.pathname).replace(/\/+$/, ""), token: typeof token === "string" && /^[!-~]+$/.test(token) ? token : null };
  } catch { return null; }
}
/** Keeps the host Claude account in step with its settings: a gateway there makes it ready with an address, no gateway takes both away. */
export async function reconcileHostGateway(store: AccountStore): Promise<void> {
  const state = await store.read();
  const account = state.accounts.find(a => a.source === "system" && a.provider === "claude");
  if (!account) return;
  const found = await readHostGateway(state);
  if (found ? account.baseUrl === found.baseUrl && account.authStatus === "ready" : !account.baseUrl) return;
  await store.change(current => {
    const target = current.accounts.find(a => a.id === account.id);
    if (!target) return;
    if (found) Object.assign(target, { baseUrl: found.baseUrl, authStatus: "ready", email: null, plan: null, identityKey: null });
    else { delete target.baseUrl; target.authStatus = "unknown"; }
    // A sign-in probe that started before this belongs to the account as it was; the new generation makes its result void.
    target.generation++;
  });
}
/** What a usage endpoint is asked with: an added gateway's stored token, or the host gateway's token from its settings. */
export async function gatewayCredentials(store: AccountStore, account: StoredAccount): Promise<{ baseUrl: string; token: string }> {
  if (account.source === "gateway") { const env = await gatewayEnvironment(store.root, account); return { baseUrl: env.ANTHROPIC_BASE_URL, token: env.ANTHROPIC_AUTH_TOKEN }; }
  const found = isHostGateway(account) ? await readHostGateway(await store.read()) : null;
  if (!found?.token || found.baseUrl !== account.baseUrl) throw new Error("The saved gateway credentials are unavailable.");
  return { baseUrl: found.baseUrl, token: found.token };
}
/** Saves how a gateway's usage is read; `null` turns the reading off. The setting holds no secret. */
export async function setGatewayUsage(store: AccountStore, accountId: string, usage: GatewayUsage | null) {
  const parsed = usage === null ? null : GatewayUsageSchema.parse(usage);
  await store.change(state => {
    const account = gatewayFrom(state, accountId);
    if (parsed) account.usage = parsed; else delete account.usage;
  });
}
/** Runs a reader once without saving it, so the form can show what it finds. The result carries amounts and labels only. */
export async function testGatewayUsage(store: AccountStore, accountId: string, usage: GatewayUsage, deps: GatewayDependencies = {}) {
  const parsed = GatewayUsageProbeSchema.parse(usage);
  const account = gatewayFrom(await store.read(), accountId);
  try {
    // A test is the user asking now: it is not held back by the once-a-minute spacing of dashboard reads.
    const reading: DashboardReading = await readGatewayUsage(parsed, () => gatewayCredentials(store, account), { ...deps, accountId: `test:${accountId}`, force: true });
    return { ok: true, plan: reading.plan, windows: reading.windows, balances: reading.balances, error: null, ...(reading.lines ? { lines: reading.lines } : {}), ...(reading.sessions ? { sessions: Object.keys(reading.sessions).length } : {}) };
  } catch (error) {
    const partial = error instanceof DashboardMissingError ? error.partial : null;
    return { ok: false, plan: null, windows: partial?.windows ?? [], balances: partial?.balances ?? [], error: error instanceof GatewayUsageError ? error.message : "The gateway's usage could not be read.", ...(partial?.lines ? { lines: partial.lines } : {}) };
  }
}

type GatewayProvider = { provider: string; label: string; baseUrl: string; token: string };
/**
 * Paseo's own custom Claude providers that are really gateways: an entry of `agents.providers` in Paseo's config.json
 * that extends `claude` and carries a base URL and a bearer token in its `env`. Read only; the config is never changed.
 */
async function gatewayProviders(configPath: string): Promise<GatewayProvider[]> {
  let providers: unknown;
  try { providers = JSON.parse(await readFile(configPath, "utf8"))?.agents?.providers; } catch { return []; }
  if (!providers || typeof providers !== "object") return [];
  const found: GatewayProvider[] = [];
  for (const [provider, entry] of Object.entries(providers as Record<string, { extends?: unknown; label?: unknown; env?: Record<string, unknown> } | null>)) {
    if (!entry || typeof entry !== "object" || (provider !== "claude" && entry.extends !== "claude")) continue;
    const url = entry.env?.ANTHROPIC_BASE_URL, token = entry.env?.ANTHROPIC_AUTH_TOKEN;
    if (typeof url !== "string" || typeof token !== "string") continue;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label : provider;
    const parsed = GatewayInput.safeParse({ label: label.slice(0, 80), base_url: url.trim().replace(/\/+$/, ""), api_token: token });
    if (parsed.success) found.push({ provider, label: parsed.data.label, baseUrl: parsed.data.base_url, token: parsed.data.api_token });
  }
  return found;
}
const sameGateway = (state: { accounts: StoredAccount[] }, baseUrl: string) => state.accounts.some(a => a.source === "gateway" && a.baseUrl?.replace(/\/+$/, "") === baseUrl);
/** The providers that can be imported: those whose gateway is not in Accounts yet. No token leaves this function. */
export async function discoverGatewayProviders(store: AccountStore, configPath: string) {
  const state = await store.read();
  return (await gatewayProviders(configPath)).filter(p => !sameGateway(state, p.baseUrl)).map(({ provider, label, baseUrl }) => ({ provider, label, baseUrl }));
}
/** Adds a gateway with the base URL and token of one of Paseo's custom providers. The provider entry stays as it is. */
export async function importGatewayProvider(store: AccountStore, configPath: string, provider: string) {
  const found = (await gatewayProviders(configPath)).find(p => p.provider === provider);
  if (!found) throw new Error("This provider has no gateway to import.");
  if (sameGateway(await store.read(), found.baseUrl)) throw new Error("This gateway is already in Accounts.");
  return addGateway(store, { label: found.label, base_url: found.baseUrl, api_token: found.token });
}
