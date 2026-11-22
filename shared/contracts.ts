import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ProviderSchema = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof ProviderSchema>;
export const cliName: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };
export const missingCli = (provider: Provider): string => `${cliName[provider]} CLI was not found on the daemon. Install it or configure its command in Paseo, then reload the plugin.`;
export const LoginModeSchema = z.enum(["device", "browser"]);
export const LoginSessionSchema = z.object({
  id: z.string(), accountId: z.string(), provider: ProviderSchema, mode: LoginModeSchema,
  status: z.enum(["starting", "waiting", "verifying", "complete", "error"]),
  authorizationUrl: z.string().nullable(), userCode: z.string().nullable(),
  canSubmitCode: z.boolean(), error: z.string().nullable(), expiresAt: z.string().nullable(),
});
export type LoginSession = z.infer<typeof LoginSessionSchema>;
export const UsageUnitSchema = z.enum(["credits", "usd", "requests", "tokens"]);
export type UsageUnit = z.infer<typeof UsageUnitSchema>;
// A dot path into a JSON reply, such as `data.total_used`; a numeric segment indexes an array.
const FieldPath = z.string().max(200).regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, "Use names separated by dots, such as data.total_used.");
const UsageFields = z.object({
  used: FieldPath.optional(), limit: FieldPath.optional(), remaining: FieldPath.optional(), usedPercent: FieldPath.optional(),
  resetsAt: FieldPath.optional(), plan: FieldPath.optional(), unlimited: FieldPath.optional(),
}).refine(f => Boolean(f.used || f.limit || f.remaining || f.usedPercent), "Name the field for used, limit, remaining or percent.");
const DashboardPage = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !/[\s\\]/.test(value); } catch { return false; }
}, "Use an https address without credentials.");
/** How a gateway's usage is read. `endpoint` asks the gateway's own origin with its token; `file` reads what another tool wrote; `dashboard` reads a signed-in page through the shared browser. */
export const GatewayUsageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("endpoint"),
    path: z.string().max(512).regex(/^\/(?!\/)[^\s\\#]*$/, "Use a path on the gateway, starting with /."),
    fields: UsageFields, unit: UsageUnitSchema, divisor: z.number().positive().finite().default(1),
    label: z.string().trim().min(1).max(40).default("Balance"),
  }),
  z.object({ kind: z.literal("file"), path: z.string().max(1024).regex(/^\/[^\0]*$/, "Use an absolute path.") }),
  z.object({
    kind: z.literal("dashboard"),
    // The shared browser's remote-debugging address. The reader opens a tab there; it never types.
    browser: z.object({
      host: z.string().min(1).max(255).regex(/^[A-Za-z0-9.-]+$/, "Enter the browser's host name or IP address."),
      port: z.number().int().min(1).max(65535),
    }).default({ host: "127.0.0.1", port: 9222 }),
    pages: z.array(DashboardPage).min(1).max(4),
    accountTile: z.string().trim().min(1).max(200).optional(),
    between: z.array(z.object({ after: z.string().trim().min(1).max(120).optional(), before: z.string().trim().min(1).max(120).optional() })).max(4).optional(),
    readings: z.array(z.object({
      label: z.string().trim().min(1).max(40), find: z.string().trim().min(1).max(120), type: z.enum(["percent", "amount"]),
      unit: UsageUnitSchema.optional(), page: z.number().int().min(0).max(3).optional(),
    }).refine(r => r.type !== "amount" || Boolean(r.unit), "Choose a unit for an amount.")).min(1).max(12),
  }).refine(d => d.readings.every(r => (r.page ?? 0) < d.pages.length), "A reading names a page that is not listed."),
]);
export type GatewayUsage = z.infer<typeof GatewayUsageSchema>;
export const BDDEV_HOST = "api.bddevlab.online";
export const BDDEV_USAGE: GatewayUsage = {
  kind: "endpoint", path: "/api/usage/token/", unit: "credits", divisor: 100000, label: "Credits",
  fields: { used: "data.total_used", limit: "data.total_granted", remaining: "data.total_available", plan: "data.name", unlimited: "data.unlimited_quota" },
};
export const AccountSchema = z.object({
  id: z.string(), provider: ProviderSchema, label: z.string(),
  source: z.enum(["managed", "system", "linked", "gateway"]), baseUrl: z.string().optional(), usage: GatewayUsageSchema.optional(), email: z.string().nullable(),
  plan: z.string().nullable(), authStatus: z.enum(["ready", "needs_auth", "unknown", "error"]),
  createdAt: z.string(),
  login: z.union([z.object({sessionId:z.string(),mode:LoginModeSchema}),z.object({workspaceId:z.string(),terminalId:z.string()})]).nullable().optional(),
});
export type Account = z.infer<typeof AccountSchema>;
export const BindingSchema = z.object({
  agentId: z.string(), provider: ProviderSchema,
  currentAccountId: z.string().nullable(), pendingAccountId: z.string().nullable(),
  status: z.enum(["ready", "switching", "error"]), error: z.string().nullable(),
});
export type Binding = z.infer<typeof BindingSchema>;
// `available`: the daemon found the provider CLI. `integrated`: its launches go through the account launcher.
export const ProviderStatusSchema = z.object({ available: z.boolean(), integrated: z.boolean() });
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
export const StateSchema = z.object({
  accounts: z.array(AccountSchema), bindings: z.array(BindingSchema),
  defaults: z.object({ claude: z.string().nullable(), codex: z.string().nullable() }),
  preferHeadroom: z.boolean().optional(),
  fallback: z.object({ claude: z.boolean(), codex: z.boolean() }).default({ claude: true, codex: true }),
  autoFailover: z.object({ claude: z.boolean(), codex: z.boolean() }).default({ claude: false, codex: false }),
  integration: z.object({ enabled: z.boolean(), error: z.string().nullable() }),
  providers: z.object({ claude: ProviderStatusSchema, codex: ProviderStatusSchema }),
});
export type AccountState = z.infer<typeof StateSchema>;
export const UsageWindowSchema = z.object({
  id: z.string(), label: z.string(), usedPercent: z.number().nullable(),
  windowDurationMins: z.number().nullable(), resetsAt: z.string().nullable(),
  // Provider-reported amounts behind the percentage, such as "3,765 of 5,000 credits left".
  detail: z.string().nullable().optional(),
  // What a full window stops: every request of the account, one model's requests, or extra paid usage.
  scope: z.enum(["account", "model", "spend"]).optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
// An amount instead of a percentage: credits, money, requests or tokens used and left.
export const UsageBalanceSchema = z.object({
  id: z.string(), label: z.string(), used: z.number().nullable(), remaining: z.number().nullable(), limit: z.number().nullable(),
  unit: UsageUnitSchema, detail: z.string().nullable().optional(),
});
export type UsageBalance = z.infer<typeof UsageBalanceSchema>;
export const UsageSnapshotSchema = z.object({
  accountId: z.string(), provider: ProviderSchema,
  status: z.enum(["ok", "stale", "needs_auth", "unavailable"]),
  plan: z.string().nullable(), windows: z.array(UsageWindowSchema),
  // Amounts a gateway reports. Absent on subscriptions and on snapshots saved before gateways had usage.
  balances: z.array(UsageBalanceSchema).optional(),
  // Model IDs the account's plan offers; null or absent when the provider does not list them.
  models: z.array(z.string()).nullable().optional(),
  // The provider's own verdict that ordinary usage is allowed (Codex `ordinaryUsageAllowed`); null when not reported.
  usageAllowed: z.boolean().nullable().optional(),
  fetchedAt: z.string().nullable(), checkedAt: z.string(), nextRetryAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
const Empty = z.object({});
const AccountId = z.object({ accountId: z.string().min(1) });
export const listAccounts = defineRpc({ name: "accounts.list", input: Empty, output: StateSchema });
export const addAccount = defineRpc({ name: "accounts.add", input: z.object({ provider: ProviderSchema, label: z.string().trim().min(1).max(80) }), output: AccountSchema });
export const GatewayInput = z.object({
  label: z.string().trim().min(1).max(80),
  base_url: z.string().trim().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !/[?#\\\s]/.test(value) &&
        (url.protocol === "https:" || url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname));
    } catch { return false; }
  }, "Use HTTPS or a loopback HTTP address without credentials, query or fragment."),
  api_token: z.string().min(1).max(8192).regex(/^[!-~]+$/, "Enter a bearer token without whitespace."),
});
export const addGateway = defineRpc({ name: "claude.gateway-add", input: GatewayInput, output: AccountSchema });
export const rotateGateway = defineRpc({ name: "claude.gateway-rotate", input: AccountId.extend({ api_token: GatewayInput.shape.api_token }), output: Empty });
export const setGatewayUsage = defineRpc({ name: "claude.gateway-usage-set", input: AccountId.extend({ usage: GatewayUsageSchema.nullable() }), output: Empty });
export const GatewayUsageTestSchema = z.object({ ok: z.boolean(), plan: z.string().nullable(), windows: z.array(UsageWindowSchema), balances: z.array(UsageBalanceSchema), error: z.string().nullable() , lines: z.array(z.array(z.string())).optional() });
export type GatewayUsageTest = z.infer<typeof GatewayUsageTestSchema>;
export const testGatewayUsage = defineRpc({ name: "claude.gateway-usage-test", input: AccountId.extend({ usage: GatewayUsageSchema }), output: GatewayUsageTestSchema });
export const listProfiles = defineRpc({ name: "claude.profiles", input: Empty, output: z.array(z.string()) });
export const linkProfile = defineRpc({ name: "claude.link", input: z.object({ name: z.string().max(255) }), output: AccountSchema });
export const setHeadroom = defineRpc({ name: "claude.headroom", input: z.object({ enabled: z.boolean() }), output: Empty });
export const moveCandidates = defineRpc({ name: "claude.move-candidates", input: AccountId, output: z.array(z.string()) });
export const moveIdleAgent = defineRpc({ name: "claude.move-idle", input: z.object({ agentId: z.string().min(1), from: z.string(), to: z.string() }), output: z.object({ moved: z.boolean(), detail: z.string() }) });
export const renameAccount = defineRpc({ name: "accounts.rename", input: AccountId.extend({ label: z.string().trim().min(1).max(80) }), output: AccountSchema });
export const removeAccount = defineRpc({ name: "accounts.remove", input: AccountId, output: Empty });
export const setDefaultAccount = defineRpc({ name: "accounts.default", input: z.object({ provider: ProviderSchema, accountId: z.string().nullable() }), output: Empty });
export const setFallback = defineRpc({ name: "accounts.fallback", input: z.object({ provider: ProviderSchema, enabled: z.boolean() }), output: Empty });
export const setAutoFailover = defineRpc({ name: "accounts.auto-failover", input: z.object({ provider: ProviderSchema, enabled: z.boolean() }), output: Empty });
export const startLogin = defineRpc({ name: "auth.start", input: AccountId.extend({ mode: LoginModeSchema.optional() }), output: LoginSessionSchema });
export const getLoginStatus = defineRpc({ name: "auth.status", input: AccountId.extend({ sessionId: z.string().min(1) }), output: LoginSessionSchema });
export const submitLoginCode = defineRpc({ name: "auth.submit-code", input: AccountId.extend({ sessionId: z.string().min(1), code: z.string().trim().min(1).max(2048) }), output: LoginSessionSchema });
export const checkLogin = defineRpc({ name: "auth.check", input: AccountId, output: AccountSchema });
export const cancelLogin = defineRpc({ name: "auth.cancel", input: AccountId.extend({ sessionId: z.string().min(1).optional() }), output: AccountSchema });
export const prepareSwitch = defineRpc({ name: "switch.prepare", input: z.object({ agentId: z.string().min(1), accountId: z.string().nullable() }), output: BindingSchema });
// `accountId`: the selection the caller saw; the switch is refused when another client changed it since.
export const applySwitch = defineRpc({ name: "switch.apply", input: z.object({ agentId: z.string().min(1), accountId: z.string().min(1).optional() }), output: BindingSchema });
// Applies the switch a failover row offers; `rowId` is that row, which shows the outcome. `fromId`: the account the offer
// moves the agent from; the switch is refused when the agent no longer runs on it.
export const applyFailover = defineRpc({ name: "failover.apply", input: z.object({ agentId: z.string().min(1), accountId: z.string().min(1), rowId: z.string().min(1), fromId: z.string().min(1).optional() }), output: Empty });
export const setIntegration = defineRpc({ name: "integration.set", input: z.object({ enabled: z.boolean() }), output: StateSchema });
export const listUsage = defineRpc({ name: "usage.list", input: z.object({ visible: z.boolean().optional() }), output: z.object({ accounts: z.array(UsageSnapshotSchema), checksOff: z.boolean().optional() }) });
export const refreshUsage = defineRpc({ name: "usage.refresh", input: z.object({ accountId: z.string().optional() }), output: z.object({ accounts: z.array(UsageSnapshotSchema), checksOff: z.boolean().optional() }) });
