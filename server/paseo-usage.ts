import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hashAccountKey, windowFromReportedDuration, type UsageAccount, type UsageDetail, type UsageReport, type UsageScope, type UsageWindow as PaseoWindow } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { cliName, isGateway, type Provider, type UsageSnapshot, type UsageWindow } from "../shared/contracts";
import type { Registry } from "./store";

// Paseo's Usage view lists every source's accounts side by side. This source adds the managed accounts, from the limits the plugin already collects.
const SOURCE_ID = "account-switcher";
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// A store locator for `fetch`, never a credential.
// `owner` narrows a gateway's reading to one of the accounts its dashboard shows: the one a session ran on.
const InputSchema = z.object({ accountId: z.string().min(1), owner: z.string().min(1).optional() });

/** The part of AccountController this source reads; the controller satisfies it. */
export interface UsageController {
  ready: Promise<void>;
  store: { read(): Promise<Pick<Registry, "accounts">> };
  usage: { list(): Promise<UsageSnapshot[]> };
}

/**
 * Paseo's stable key for an account: the Codex account ID as is, a Claude identity with its `provider:` prefix written `provider-`.
 * Anything Paseo would refuse (an email, a long or empty value) is replaced by a hash, so the key never exposes the identity.
 */
export function usageKey(provider: Provider, identityKey: string): string {
  const prefix = `${provider}:`;
  const key = identityKey.startsWith(prefix) ? `${provider}-${identityKey.slice(prefix.length)}` : identityKey;
  return KEY_PATTERN.test(key) ? key : hashAccountKey(identityKey);
}

/**
 * Managed accounts for the Usage view's global list. The system account is left to Paseo's built-in source, and so is any managed account signed in as that same login.
 * The session scope is also left to the built-in source: the account profile in an agent's environment (see session-env.ts) already points it at the right login.
 * The one exception is a session a gateway's dashboard lists: it gets the account the gateway ran it on, which no login on this host can tell.
 */
export function discoverAccounts(registry: Pick<Registry, "accounts">, scope: UsageScope, snapshots: UsageSnapshot[] = []): UsageAccount[] {
  if (scope.kind !== "global") return sessionAccount(registry, scope, snapshots);
  const systemIdentity = (provider: Provider) => registry.accounts.find(a => a.source === "system" && a.provider === provider)?.identityKey ?? null;
  const found = new Map<string, UsageAccount>();
  for (const account of registry.accounts) {
    // A gateway has no login to compare. It is listed once it has a usage reader, under a hash of its own id.
    if (isGateway(account)) {
      if (account.usage) found.set(`gateway:${account.id}`, { key: hashAccountKey(`gateway:${account.id}`), label: account.label, harness: cliName[account.provider], input: { accountId: account.id } });
      continue;
    }
    // `loginToken` marks a sign-in still in progress. An `error` status is a failed check, so the last limits stay worth showing.
    if ((account.source !== "managed" && account.source !== "linked") || account.authStatus === "needs_auth" || account.loginToken || !account.identityKey) continue;
    if (account.identityKey === systemIdentity(account.provider)) continue;
    const key = usageKey(account.provider, account.identityKey);
    // Two accounts signed in as one login are one account to Paseo, which wants unique keys.
    if (found.has(key)) continue;
    found.set(key, { key, label: account.label, harness: cliName[account.provider], input: { accountId: account.id } });
  }
  return [...found.values()];
}

type SessionScope = Extract<UsageScope, { kind: "session" }> & { sessionId?: string };
/** Looks up the provider's own session id of an agent; null when the agent has none yet or cannot be asked. */
export type SessionIdOf = (agentId: string) => Promise<string | null>;

/**
 * The scope with the session's id. Paseo does not pass it, but the session's environment names its agent
 * (`PASEO_AGENT_ID`), and the agent's runtime information holds the id.
 */
export async function withSessionId(scope: UsageScope, sessionIdOf: SessionIdOf | undefined): Promise<UsageScope> {
  if (scope.kind !== "session" || (scope as SessionScope).sessionId) return scope;
  const agentId = scope.env.PASEO_AGENT_ID;
  const sessionId = agentId && sessionIdOf ? await sessionIdOf(agentId).catch(() => null) : null;
  return sessionId ? { ...scope, sessionId } as SessionScope : scope;
}

/** Without the session's id no session can be matched. */
function sessionAccount(registry: Pick<Registry, "accounts">, scope: SessionScope, snapshots: UsageSnapshot[]): UsageAccount[] {
  const sessionId = scope.sessionId;
  if (!sessionId) return [];
  for (const snapshot of snapshots) {
    const account = registry.accounts.find(candidate => candidate.id === snapshot.accountId);
    if (!account || !isGateway(account) || account.provider !== scope.provider) continue;
    const prefix = Object.keys(snapshot.sessions ?? {}).find(start => sessionId.startsWith(start));
    if (!prefix) continue;
    const owner = snapshot.sessions![prefix];
    return [{ key: hashAccountKey(`gateway:${account.id}:${owner}`), label: owner, harness: cliName[account.provider], input: { accountId: account.id, owner } }];
  }
  return [];
}

// Without a reported duration the Codex collector labels a window by its response slot ("codex · primary"). A slot says where the window sat in the response, not which quota it is.
const SLOT = / · (?:primary|secondary)$/;

/**
 * A window's quota name for Paseo's ids, which pinned windows are matched by. It comes from the label, which names the quota
 * and (for model windows) its period. The collectors' window IDs do not: they are response positions ("weekly_scoped:0", "gpt-5.3-codex-spark:primary").
 */
function quotaName(label: string): string {
  const slug = label.replace(SLOT, "").toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^-+|-+$/g, "");
  // A label with no ASCII letters or digits has nothing to slug.
  return slug || `quota-${hashAccountKey(label).slice(0, 12)}`;
}

function paseoWindow(window: UsageWindow): PaseoWindow {
  const model = window.scope === "model";
  const name = quotaName(window.label);
  const mapped = windowFromReportedDuration({
    durationSeconds: window.windowDurationMins === null ? null : window.windowDurationMins * 60,
    scope: model ? { id: name, label: window.label } : undefined,
    // Paseo prefixes a model window's id with its scope, which already says everything the label does.
    unknown: { id: model ? "window" : name, label: window.label, shortLabel: "" },
    utilizationPct: window.usedPercent,
    resetsAt: window.resetsAt,
    summary: window.scope === "account",
  });
  if (!model) return mapped;
  // The plugin's model label already names the duration ("Weekly · sonnet"), so the helper's would repeat it.
  const { shortLabel: _repeated, ...rest } = mapped;
  return { ...rest, label: window.label };
}

/** Two readings that name the same quota and period cannot be told apart; numbering the later ones keeps ids unique, which is the only place order enters an id. */
function withUniqueIds(windows: PaseoWindow[]): PaseoWindow[] {
  const seen = new Map<string, number>();
  return windows.map(window => {
    const count = (seen.get(window.id) ?? 0) + 1;
    seen.set(window.id, count);
    return count === 1 ? window : { ...window, id: `${window.id}:${count}` };
  });
}

/** A gateway's reading for one of the accounts its dashboard shows: that account's windows under their own names, and no amounts, which belong to the gateway as a whole. */
function ownedBy(snapshot: UsageSnapshot, owner: string): UsageSnapshot {
  const suffix = ` · ${owner}`;
  const windows = snapshot.windows.filter(window => window.owner === owner).map(window => ({ ...window, label: window.label.endsWith(suffix) ? window.label.slice(0, -suffix.length) : window.label }));
  return { ...snapshot, windows, balances: [] };
}

export function usageReport(snapshot: UsageSnapshot | undefined, owner?: string): UsageReport {
  if (snapshot && owner) {
    const owned = ownedBy(snapshot, owner);
    if (snapshot.status !== "unavailable" && !owned.windows.length) return { status: "error", error: "The gateway's dashboard shows no limits for this account." };
    return usageReport(owned);
  }
  if (snapshot?.status === "needs_auth") return { status: "error", error: "Needs sign-in in Account Switcher." };
  // Only a gateway's snapshot carries `balances`, and its error is already a reason written for the user.
  if (snapshot?.status === "unavailable" && snapshot.balances && snapshot.error) return { status: "error", error: snapshot.error };
  if (!snapshot || snapshot.status === "unavailable") return { status: "error", error: "No usage data from the provider yet." };
  // A stale snapshot keeps the last good reading; the plugin's own view marks it, Paseo's has no place for that.
  // A window with neither a percentage nor a detail is a limit the provider names without data (Claude lists several);
  // Paseo's own sources leave those out, and a row of empty meters would only be noise.
  const reported = snapshot.windows.filter(window => window.usedPercent !== null || window.detail?.trim());
  const windows = withUniqueIds(reported.map(paseoWindow));
  const details = reported.flatMap((window, index): UsageDetail[] => {
    const text = window.detail?.trim();
    const shown = windows[index];
    return text && shown ? [{ id: shown.id, label: shown.label, value: text }] : [];
  });
  const balances = (snapshot.balances ?? []).map(({ id, label, used, remaining, limit, unit }) => ({ id, label, used, remaining, limit, unit }));
  for (const balance of snapshot.balances ?? []) if (balance.detail?.trim()) details.push({ id: balance.id, label: balance.label, value: balance.detail.trim() });
  return { status: "available", ...(snapshot.plan ? { planLabel: snapshot.plan } : {}), windows, ...(balances.length ? { balances } : {}), ...(details.length ? { details } : {}) };
}

/** Registers the source; false on a daemon without usage sources (Paseo before 0.11). */
export function registerPaseoUsage(server: PluginServerContext, controller: UsageController, sessionIdOf?: SessionIdOf): boolean {
  if (typeof server.registerUsageSource !== "function") return false;
  server.registerUsageSource({
    id: SOURCE_ID,
    label: "Account Switcher",
    input: InputSchema,
    async discover(scope) {
      await controller.ready;
      // Only a session needs the readings, to find the gateway that lists it.
      if (scope.kind !== "session") return discoverAccounts(await controller.store.read(), scope);
      const snapshots = await controller.usage.list();
      // The agent is asked only when some gateway lists sessions at all.
      const listed = snapshots.some(snapshot => snapshot.sessions && Object.keys(snapshot.sessions).length);
      return discoverAccounts(await controller.store.read(), listed ? await withSessionId(scope, sessionIdOf) : scope, snapshots);
    },
    // The plugin's cached snapshot: opening the Usage view never costs a provider request.
    async fetch(input) {
      const { accountId, owner } = InputSchema.parse(input);
      const snapshots = await controller.usage.list();
      return usageReport(snapshots.find(snapshot => snapshot.accountId === accountId), owner);
    },
  });
  return true;
}
