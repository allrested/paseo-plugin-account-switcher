# Gateway Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude gateway in Accounts can show usage, read from a configurable JSON endpoint on the gateway (BDDev as a preset), from a signed-in dashboard page through the shared browser, or from a file another tool writes.

**Architecture:** A gateway's registry record gains an optional `usage` setting. A new collector (`server/usage/gateway.ts`) turns that setting into a reading with windows and the new `balances`; it runs behind the existing usage scheduler, which learns to accept gateway accounts. Two RPCs save and test the setting; the client shows balances in the existing quota summary and offers a form under a gateway's Manage section.

**Tech Stack:** TypeScript, zod, the Chrome DevTools Protocol over the shared browser's debugging port (no library), the Paseo plugin SDK (`defineRpc`, `registerUsageSource`), React (client), vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-gateway-usage-design.md`

## Global Constraints

- The gateway token is sent only to the origin of the account's `baseUrl`. The JSON reader takes a `path` starting with `/`, never a full URL.
- The token is read only through `gatewayEnvironment()` in `server/claude-profiles.ts`.
- Request: `GET`, `Authorization: Bearer <token>`, `Accept: application/json`, 15 second timeout, `redirect: "error"`, at most 256 KB read.
- No token and no part of a response other than mapped numbers and labels appears in a reading, an error message, a log or an RPC result.
- A mapped field that is missing or not a number gives `unavailable` naming the field path. It never becomes 0.
- A gateway never gets status `needs_auth`. A 401 or 403 is `unavailable` with "The gateway refused the token (<status>)."
- An external file reading older than 30 minutes is `stale`. The file is a regular file of at most 256 KB.
- Gateways stay out of headroom balancing, failover, idle-move and defaults. Do not touch `server/switching.ts`, `server/failover.ts` or the gateway checks in `index.server.ts` and `client/command.ts`.
- `balances` on `UsageSnapshot` and `usage` on `AccountSchema` are optional; a registry or cache written before this change parses unchanged. The registry stays at version 1.
- A gateway without `usage` behaves exactly as today (card text "Gateway configured", not polled).
- Units: `credits`, `usd`, `requests`, `tokens`.
- Follow the file's existing style where you edit (several server files are dense single-line style; match it).
- Commits and PRs carry no AI attribution lines. Branch from `origin/main` as `feat/gateway-usage`.
- Verify with `npm run check` (build, typecheck, tests) before each commit.

## Review Focus

1. The usage reply is HTML or not JSON (a gateway's login page, a 200 with an error page) → `unavailable` "The usage reply is not JSON.", and nothing of the body is shown (Task 1).
2. A field holds a numeric string, `null`, a boolean or an object → strings that are numbers are accepted, everything else is "no number at <path>" (Task 1).
3. The user changes the mapping while an old reading is cached → the old reading is dropped, not shown under the new labels (Task 2).
4. The external file is half-written, a symlink, a directory or larger than 256 KB → `unavailable` with a plain reason, and the previous good reading stays as `stale` (Tasks 1 and 2).
5. `limit` is 0 or `unlimited` is true → no bar and no division by zero; the row reads "Unlimited" or shows the used amount alone (Tasks 1 and 3).

---

### Task 1: The setting's shape and the reader

**Files:**
- Modify: `shared/contracts.ts`
- Create: `server/usage/gateway.ts`
- Create: `tests/gateway-usage.test.ts`
- Create: `tests/fixtures/bddev-usage.json` (a made-up reply in BDDev's shape: `{"data":{"name":"Team","total_granted":100000000,"total_used":58800000,"total_available":41200000,"unlimited_quota":false}}`)

**Interfaces:**
- Produces, in `shared/contracts.ts`:
  - `UsageUnitSchema = z.enum(["credits","usd","requests","tokens"])`
  - `GatewayUsageSchema`: a union discriminated on `kind`:
    - `{ kind:"endpoint", path, fields:{used?,limit?,remaining?,usedPercent?,resetsAt?,plan?,unlimited?}, unit, divisor (positive, default 1), label (1–40 chars, default "Balance") }`. `path` starts with `/`, max 512 chars, no whitespace, backslash or `#`, and no `//` at the start. Each field path is dot-separated segments of `[A-Za-z0-9_-]+`, max 200 chars. At least one of `used`, `limit`, `remaining`, `usedPercent`.
    - `{ kind:"file", path }`: an absolute path, max 1024 chars.
  - `type GatewayUsage`
  - `BDDEV_USAGE: GatewayUsage` with the spec's preset values, and `BDDEV_HOST = "api.bddevlab.online"`
  - `UsageBalanceSchema = { id, label, used: number|null, remaining: number|null, limit: number|null, unit, detail?: string|null }`, `type UsageBalance`
  - `UsageSnapshotSchema.balances`: `z.array(UsageBalanceSchema).optional()`
  - `AccountSchema.usage`: `GatewayUsageSchema.optional()`
- Produces, in `server/usage/gateway.ts`:
  - `type GatewayReading = { plan: string|null; windows: UsageWindow[]; balances: UsageBalance[]; fetchedAt?: string }`
  - `class GatewayUsageError extends Error { constructor(message: string, readonly retryAfterMs?: number, readonly stale = false) }`
  - `readEndpointUsage(usage: Extract<GatewayUsage,{kind:"endpoint"}>, gateway: { baseUrl: string; token: string }, deps?: { fetch?: typeof fetch; signal?: AbortSignal }): Promise<GatewayReading>`
  - `readFileUsage(usage: Extract<GatewayUsage,{kind:"file"}>, deps?: { now?: () => number }): Promise<GatewayReading>`
  - `readGatewayUsage(usage: GatewayUsage, gateway: () => Promise<{ baseUrl: string; token: string }>, deps?): Promise<GatewayReading>`: dispatches on `kind`; calls `gateway()` only for `endpoint`.

- [ ] **Step 1: Write the failing tests** in `tests/gateway-usage.test.ts`. Inject `fetch` as `vi.fn(async () => new Response(...))`, as `tests/usage-collectors.test.ts` does. One test per line:

```ts
// BDDev preset against the fixture
expect(reading).toEqual({ plan: "Team", windows: [], balances: [
  { id: "balance", label: "Credits", used: 588, remaining: 412, limit: 1000, unit: "credits", detail: null }] });
expect(fetchMock).toHaveBeenCalledWith("https://api.bddevlab.online/api/usage/token/", expect.objectContaining({
  method: "GET", redirect: "error",
  headers: { Authorization: "Bearer T0KEN", Accept: "application/json" } }));

// the request stays on the gateway's origin whatever the base URL's path is
// baseUrl "https://gw.example/anthropic/v1", path "/usage?x=1" → "https://gw.example/usage?x=1"

// a missing third amount is worked out: used 30 + limit 100 → remaining 70; used 30 + remaining 70 → limit 100
// numeric strings count: "41200000" with divisor 100000 → 412
// usedPercent 42.5 + resetsAt → windows: [{ id:"window", label:<usage.label>, usedPercent:42.5, windowDurationMins:null, resetsAt:<ISO> }]
// resetsAt accepts an ISO string, epoch seconds (1795400000) and epoch milliseconds, all giving the same ISO time
// unlimited true → balance { limit:null, remaining:null, detail:"Unlimited" }, used kept when mapped
// limit 0 → balance { limit:null, ... }, never a division by zero

await expect(read(missingField)).rejects.toThrow("The usage reply has no number at data.total_used.");
await expect(read(fieldIsObject)).rejects.toThrow("The usage reply has no number at data.total_used.");
await expect(read(htmlBody)).rejects.toThrow("The usage reply is not JSON.");
await expect(read(status401)).rejects.toThrow("The gateway refused the token (401).");
await expect(read(status403)).rejects.toThrow("The gateway refused the token (403).");
await expect(read(status500)).rejects.toThrow("The gateway's usage request failed (500).");
await expect(read(status429WithRetryAfter30)).rejects.toMatchObject({ retryAfterMs: 30_000 });
await expect(read(bodyOver256KB)).rejects.toThrow("The usage reply is too large.");
// no error message contains the token or any text from the response body
```

File kind, with real files in a temp directory:

```ts
// { fetchedAt: now, report: { status:"available", planLabel:"Team A", windows:[{ id:"s", label:"Current session", usedPct:40, resetsAt:<ISO> }],
//   balances:[{ id:"today", label:"Today", used:3.2, unit:"usd" }] } }
expect(reading).toEqual({ plan: "Team A", fetchedAt: <same ISO>,
  windows: [{ id:"s", label:"Current session", usedPercent:40, windowDurationMins:null, resetsAt:<ISO> }],
  balances: [{ id:"today", label:"Today", used:3.2, remaining:null, limit:null, unit:"usd", detail:null }] });
await expect(read(missing)).rejects.toThrow("The usage file is missing.");
await expect(read(directoryOrSymlink)).rejects.toThrow("The usage file is not a regular file.");
await expect(read(over256KB)).rejects.toThrow("The usage file is too large.");
await expect(read(halfWrittenJson)).rejects.toThrow("The usage file is not a usage report.");
await expect(read(reportStatusError)).rejects.toThrow("The usage file reports no usage.");
await expect(read(fetchedAt31MinutesAgo)).rejects.toMatchObject({ stale: true, message: "The usage file is older than 30 minutes." });
```

Schema tests: `GatewayUsageSchema` rejects `path: "https://evil.example/x"`, `path: "//evil.example/x"`, a field path `"a..b"` or `"a[0]"`, an `endpoint` setting with no amount field, `divisor: 0`; accepts `BDDEV_USAGE`; a snapshot without `balances` and an account without `usage` still parse.

- [ ] **Step 2: Run them.** `npx vitest run --config tests/vitest.config.ts tests/gateway-usage.test.ts` → FAIL (module not found).

- [ ] **Step 3: Add the schemas to `shared/contracts.ts`** as listed under Interfaces.

- [ ] **Step 4: Write `server/usage/gateway.ts`.** Build the request URL with `new URL(usage.path, new URL(gateway.baseUrl).origin)` and refuse if the result's origin differs. Timeout and abort follow `server/usage/claude.ts:98-116`. Read the body as a stream and stop at 256 KB. A field path walks objects by key and arrays by numeric segment. For the file kind use `lstat` (so a symlink is refused), then read and parse; convert Paseo's `usedPct` to `usedPercent` (when only `remainingPct` is present, `100 - remainingPct`).

- [ ] **Step 5: Run the tests.** → PASS. Then `npm run check` → PASS.

- [ ] **Step 6: Commit** (`Read a gateway's usage from a JSON endpoint or a file`).

### Task 2: The scheduler, the controller and the two RPCs

**Files:**
- Modify: `server/usage/index.ts`, `server/usage/README.md`
- Modify: `server/controller.ts` (`readQuotaAccounts`, `toQuotaAccount`)
- Modify: `server/claude-profiles.ts`, `index.server.ts`, `shared/contracts.ts`
- Test: `tests/usage.test.ts`, `tests/usage-controller.test.ts`, `tests/claude-profiles.test.ts`

**Interfaces:**
- Consumes: `readGatewayUsage`, `GatewayUsageError`, `GatewayUsage`, `UsageBalance` from Task 1.
- Produces:
  - `QuotaAccount.gateway?: { usage: GatewayUsage; credentials: () => Promise<{ baseUrl: string; token: string }> }`
  - `CollectedUsage.balances?: UsageBalance[]` and `CollectedUsage.fetchedAt?: string`
  - `UsageError` takes an optional fourth argument `message?: string` that replaces the generic text
  - `setGatewayUsage(store: AccountStore, accountId: string, usage: GatewayUsage | null): Promise<void>` in `server/claude-profiles.ts`
  - RPCs in `shared/contracts.ts`: `setGatewayUsage = defineRpc({ name:"claude.gateway-usage-set", input: AccountId.extend({ usage: GatewayUsageSchema.nullable() }), output: Empty })` and `testGatewayUsage = defineRpc({ name:"claude.gateway-usage-test", input: AccountId.extend({ usage: GatewayUsageSchema }), output: z.object({ ok: z.boolean(), plan: z.string().nullable(), windows: z.array(UsageWindowSchema), balances: z.array(UsageBalanceSchema), error: z.string().nullable() }) })`
  - Snapshots of gateway accounts carry `balances`.

- [ ] **Step 1: Write the failing tests.**

In `tests/usage.test.ts` (scheduler, with `fetchUsage` mocked as the file already does), for an account `{ id:"g1", provider:"claude", identityKey:"gateway:g1", generation:0, command:[], home:"/x", env:{}, gateway:{...} }`:

```ts
// a successful read gives status "ok" with the balances and no identity checks run
expect(snapshot).toMatchObject({ accountId:"g1", status:"ok", balances:[{ label:"Credits", remaining:412 }] });
// a later failed read keeps the last reading
expect(snapshot).toMatchObject({ status:"stale", balances:[{ remaining:412 }], error:"The gateway refused the token (401)." });
// a first read that fails is unavailable, never needs_auth
expect(snapshot).toMatchObject({ status:"unavailable", error:"The usage reply has no number at data.total_used." });
// a new service created on the same cachePath shows the last good reading before its first read
// a GatewayUsageError with retryAfterMs 30_000 sets nextRetryAt at least 30 s ahead
// a GatewayUsageError with stale:true and no earlier reading is "unavailable" with its message
```

In `tests/usage-controller.test.ts`: a gateway with `usage` is returned by the controller's account list for the scheduler with `identityKey === "gateway:" + id`, `requireIdentityVerification` falsy and `command` empty; a gateway without `usage` is not returned; a gateway with `usage` is returned even when `state.available.claude` is false; no credential probe (`probeAccount`, `readCredentialVersion`) is called for it.

In `tests/claude-profiles.test.ts`: `setGatewayUsage` stores the setting on a gateway and `null` removes it; it throws "Choose a Claude gateway." for a non-gateway account; the existing assertion at line 80 (a gateway is absent from usage) still holds for a gateway without `usage`. With the file's real `http.createServer` (lines 58-61) serving the BDDev fixture, the `claude.gateway-usage-test` handler returns `{ ok:true, balances:[{ remaining:412 … }] }` and, against a 401, `{ ok:false, error:"The gateway refused the token (401).", windows:[], balances:[] }`; the result never contains the token.

A changed mapping drops the old reading: after `setGatewayUsage` with a different `fields`, the account's snapshot is not the old one (Review Focus 3).

- [ ] **Step 2: Run them.** → FAIL.

- [ ] **Step 3: Scheduler (`server/usage/index.ts`).** `fetchProvider` calls `readGatewayUsage(account.gateway.usage, account.gateway.credentials, { signal })` when `account.gateway` is set and maps `GatewayUsageError` to `new UsageError("unavailable", "gateway_usage", error.retryAfterMs, error.message)`. Snapshots carry `balances` from the collected usage (and keep the previous ones when stale). Include the `usage` setting in the fingerprint at line 35 so a changed setting does not restore the old reading. The identity gates at lines 101-105 and 174 already pass for a non-null `identityKey` with `requireIdentityVerification` false; add nothing gateway-specific there.

- [ ] **Step 4: Controller.** In `readQuotaAccounts`, gateways with `usage` join the list, without the `available`/`commands` condition and without `checkAccount`. For them `toQuotaAccount` returns `{ id, provider:"claude", home: account.home, command: [], env: {}, identityKey: "gateway:" + id, generation, gateway: { usage, credentials } }` where `credentials` calls `gatewayEnvironment(this.store.root, account)` and returns `{ baseUrl: ANTHROPIC_BASE_URL, token: ANTHROPIC_AUTH_TOKEN }`.

- [ ] **Step 5: `setGatewayUsage` and the handlers.** `claude.gateway-usage-set`: save, then `usage.invalidate(accountId)` and `usage.refresh(accountId)` on the controller's usage service. `claude.gateway-usage-test`: load the account, require `source === "gateway"`, run `readGatewayUsage` once and return the result shape; never save.

- [ ] **Step 6: Run the tests.** `npm run check` → PASS. Update `server/usage/README.md` with a short "Gateways" section (what joins the scheduler, the fixed identity, the error rule).

- [ ] **Step 7: Commit** (`Poll gateway usage and add the RPCs that set and test it`).

### Task 3: Showing it and setting it in Accounts

**Files:**
- Modify: `client/components.tsx` (balance row inside `QuotaSummary`), `client/format.ts`
- Modify: `client/account-card.tsx:96`, `client/switcher.tsx:73`
- Create: `client/gateway-usage.tsx` (the Usage form)
- Modify: `client/account-card.tsx` (Manage section mounts the form for gateways)
- Test: `tests/ui-account-card.test.ts`, create `tests/ui-gateway-usage.test.ts`, create `tests/format-balance.test.ts`

**Interfaces:**
- Consumes: `UsageBalance`, `GatewayUsage`, `BDDEV_USAGE`, `BDDEV_HOST`, the two RPCs.
- Produces: `formatBalance(balance: UsageBalance): string` and `balancePercent(balance: UsageBalance): number | null` in `client/format.ts`; `GatewayUsageForm({ theme, account, onSaved })` in `client/gateway-usage.tsx`.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/format-balance.test.ts
expect(formatBalance({ used:588, remaining:412, limit:1000, unit:"credits" })).toBe("412 of 1,000 credits left");
expect(formatBalance({ used:38.2, remaining:null, limit:null, unit:"usd" })).toBe("$38.20 used");
expect(formatBalance({ used:null, remaining:12.5, limit:null, unit:"usd" })).toBe("$12.50 left");
expect(formatBalance({ used:1200, remaining:null, limit:null, unit:"requests" })).toBe("1,200 requests used");
expect(formatBalance({ used:10, remaining:null, limit:null, unit:"credits", detail:"Unlimited" })).toBe("10 credits used · Unlimited");
expect(balancePercent({ used:588, remaining:412, limit:1000 })).toBe(58.8);
expect(balancePercent({ used:5, remaining:null, limit:null })).toBeNull();
expect(balancePercent({ used:5, remaining:null, limit:0 })).toBeNull();
```

In `tests/ui-account-card.test.ts` (follow its existing render helpers): a gateway with `usage` and a snapshot with one balance renders the balance's label and "412 of 1,000 credits left"; a gateway without `usage` still renders "Gateway configured" and no quota summary; a gateway with `usage` and an `unavailable` snapshot renders the snapshot's error text.

In `tests/ui-gateway-usage.test.ts`: the form offers Off, Usage endpoint, External reading (Usage dashboard arrives in Task 5); in Usage endpoint, "Fill in for BDDev" fills the path `/api/usage/token/` and the three field paths; for a gateway whose `baseUrl` host is `api.bddevlab.online` and no setting, that button is shown first; a full address typed into the endpoint field is accepted when its origin is the gateway's and saved as its path, and refused otherwise; **Test** calls `claude.gateway-usage-test` with the form's value and shows the returned amounts or the returned error; **Save** calls `claude.gateway-usage-set` with the value, and with `null` for Off; **Save** is disabled while the value does not pass `GatewayUsageSchema`.

- [ ] **Step 2: Run them.** → FAIL.

- [ ] **Step 3: Implement.** `QuotaSummary` renders `snapshot.balances` after the windows, each as a row in the style of `QuotaWindowRow` (label, the `formatBalance` text, a bar only when `balancePercent` is a number). Drop the `account.source !== "gateway"` condition at `account-card.tsx:96` and `switcher.tsx:73` in favour of "not a gateway, or a gateway with `usage`". The form uses the existing `Field`, `Button`, `Notice` and `row` components and the RPC calling pattern of `client/claude-tools.tsx`.

- [ ] **Step 4: Run the tests.** `npm run check` → PASS.

- [ ] **Step 5: Commit** (`Show gateway usage in Accounts and add its settings form`).

### Task 4: Paseo's Usage view and the docs

**Files:**
- Modify: `server/paseo-usage.ts` (`discoverAccounts`, `usageReport`)
- Test: `tests/paseo-usage.test.ts`
- Modify: `README.md` (the gateway bullet list), `docs/architecture.md` (stored data), `CHANGELOG.md`

**Interfaces:**
- Consumes: snapshots with `balances` (Task 2).

- [ ] **Step 1: Write the failing tests** in `tests/paseo-usage.test.ts`:

```ts
// global scope: a gateway with `usage` is discovered
expect(found).toContainEqual({ key: hashAccountKey("gateway:" + id), label: "BDDev", harness: "claude", input: { accountId: id } });
// a gateway without `usage` is not; session scope still returns []
// a snapshot with one balance and no windows becomes an available report
expect(report).toMatchObject({ status: "available", planLabel: "Team", windows: [],
  balances: [{ id: "balance", label: "Credits", used: 588, remaining: 412, limit: 1000, unit: "credits" }] });
// an unlimited balance adds details [{ label: "Credits", value: "Unlimited" }]
// an unavailable gateway snapshot becomes status "error" with the snapshot's error text (never "expired")
```

Check `harness` and the exact `UsageAccount` shape against the existing tests in this file before writing the assertion.

- [ ] **Step 2: Run them.** → FAIL.

- [ ] **Step 3: Implement** in `server/paseo-usage.ts`: `discoverAccounts` adds gateways with `usage` (no `identityKey` requirement, no system-identity comparison); `usageReport` maps `balances` one to one and applies the two rules above.

- [ ] **Step 4: Run the tests.** `npm run check` → PASS.

- [ ] **Step 5: Docs.** README: under the gateway bullets, one bullet on **Manage → Usage** (the choices, that the token goes only to the gateway's own address, that usage is shown and never used for automatic choices) and the external file's shape in a short code block. `docs/architecture.md`: the `usage` field on a gateway's registry record. `CHANGELOG.md`: an entry under the unreleased heading.

- [ ] **Step 6: Commit** (`Report gateway usage to the Usage view and document it`), push, open a PR against the fork's `main`.

- [ ] **Step 7: Try it for real (owner's yes).** After merge, on this instance: `paseo plugin update account-switcher`, add or open the BDDev gateway in Accounts, choose **Usage → Usage endpoint**, press **Fill in for BDDev**, then **Test**. Expected: credits granted, used and left that match BDDev's own dashboard. This is the only step that calls the real gateway.

### Task 5: Usage dashboard (a signed-in page through the shared browser)

Do this task after Task 2. Its form work extends Task 3's form; either order works because the kind is one more branch in each place.

**Files:**
- Create: `server/usage/dashboard/cdp.ts`, `server/usage/dashboard/pages.ts` (ported from the owner's private plugin at `a private plugin's `server/``; do NOT port `scrape.ts`, `snapshot.ts`, `usage.ts` or `config.ts`)
- Create: `server/usage/dashboard/rules.ts`, `server/usage/dashboard/index.ts`
- Create: `tests/dashboard-rules.test.ts`, `tests/dashboard-pages.test.ts`, `tests/dashboard-reader.test.ts`, `tests/fixtures/dashboard/limits.txt`, `tests/fixtures/dashboard/usage.txt`, `tests/helpers/fake-tab.ts` (ported from that repo's `test/fake-tab.ts`)
- Modify: `shared/contracts.ts`, `server/usage/gateway.ts`, `index.server.ts` (test RPC output), `client/gateway-usage.tsx`, `README.md`

**Interfaces:**
- Consumes: `GatewayReading`, `GatewayUsageError`, `readGatewayUsage` (Task 1); the form (Task 3); `testGatewayUsage` (Task 2).
- Produces:
  - `GatewayUsageSchema` gains `{ kind:"dashboard", browser:{ host (hostname or IP, max 255, default "127.0.0.1"), port (1–65535, default 9222) }, pages: 1–4 https URLs (max 2048 chars each, no credentials), accountTile?: string (1–200), between?: { after?: string; before?: string }[] (one per page, optional), readings: 1–12 of { label (1–40), find (1–120), type:"percent"|"amount", unit?: UsageUnit (required for amount), page?: 0–3 } }`
  - `extractReadings(lines: string[], readings: Rule[], now: Date): { windows: UsageWindow[]; balances: UsageBalance[]; missing: string[] }` in `rules.ts` (pure)
  - `pageLines(text: string, between?: { after?: string; before?: string }): string[]` in `rules.ts`
  - `readDashboardUsage(accountId: string, usage, deps?: { openTab?: OpenTab; now?: () => Date }): Promise<GatewayReading & { lines?: string[][] }>` in `index.ts`
  - `testGatewayUsage`'s output gains `lines: z.array(z.array(z.string())).optional()` (per page, at most 300 lines each)

- [ ] **Step 1: Write the two fixtures by hand**, made up, in the caption-then-value layout (a caption line, a blank line, a value line). `limits.txt`: a heading `team-a`, then two blocks each starting with an email line (`one@example.com`, `two@example.com`), each with `Weekly · all models` → `99%` / `29%` followed by a line ending `resets in 1d 18h` / `resets in 3d 19h`, and `Weekly · Fable` → `0%` / `10%`; then a heading `team-b` with one more block. `usage.txt`: `REQUESTS` → `2,059`, `OUTPUT TOKENS` → `2.2M` then `2,158,984`, `EST. COST` → `$38.20`. No real organisation, person or host name in any file; search `server`, `tests`, `README.md` and `docs` for the private plugin's organisation and product names → no match.

- [ ] **Step 2: Write the failing tests.**

`tests/dashboard-rules.test.ts`:

```ts
const now = new Date("2026-11-22T00:00:00Z");
// between: only team-a's lines
const lines = pageLines(limitsText, { after: "team-a", before: "team-b" });
const out = extractReadings(lines, [{ label:"Weekly", find:"weekly · all models", type:"percent" }], now);
expect(out.windows).toEqual([
  { id:"weekly-1", label:"Weekly · one@example.com", usedPercent:99, windowDurationMins:null, resetsAt:"2026-11-23T18:00:00.000Z" },
  { id:"weekly-2", label:"Weekly · two@example.com", usedPercent:29, windowDurationMins:null, resetsAt:"2026-11-25T19:00:00.000Z" }]);
expect(out.missing).toEqual([]);
// a caption that occurs once keeps the plain label and id "weekly"
// several occurrences with no email above them are labelled "Weekly · 1", "Weekly · 2"
// amounts
expect(extractReadings(pageLines(usageText), [
  { label:"Cost", find:"EST. COST", type:"amount", unit:"usd" },
  { label:"Requests", find:"REQUESTS", type:"amount", unit:"requests" },
  { label:"Output", find:"OUTPUT TOKENS", type:"amount", unit:"tokens" }], now).balances).toEqual([
  { id:"cost", label:"Cost", used:38.2, remaining:null, limit:null, unit:"usd", detail:null },
  { id:"requests", label:"Requests", used:2059, remaining:null, limit:null, unit:"requests", detail:null },
  { id:"output", label:"Output", used:2200000, remaining:null, limit:null, unit:"tokens", detail:null }]);
// number forms: "99%", "2,059", "$1,234.50", "26.7K" → 26700, "2.2M" → 2200000, "1.5B"
// the value is searched in the next three lines only; a caption followed by three text lines is missing
// a percent rule ignores a value without "%"; an amount rule ignores a value with "%"
// a rule that finds nothing is listed in `missing` by its `find` text, and the other rules still produce readings
// an ISO time within two lines after a percent sets resetsAt; no phrase → resetsAt null
```

`tests/dashboard-pages.test.ts`: port the private repo's `pages.test.ts` cases with the fake tab, with the generic wording: a page that ends on the dashboard's host returns its text; a page that ends on another host with a tile whose text equals `accountTile` gets one click and is read again; with no matching tile, or no `accountTile`, it rejects "Sign in to the dashboard in the shared browser."; the reader never sends a key event (assert no `Input.dispatchKeyEvent` / `Input.insertText` call on the fake tab).

`tests/dashboard-reader.test.ts`:

```ts
// two pages, rules on page 0 and page 1 → one reading holding both pages' windows and balances
// every tab the reader opened is closed, also when a page fails
// openTab throwing → rejects "The browser is unreachable at browser.example:9222."
// a rule with nothing found → rejects "No line 'EST. COST' on the page." (GatewayUsageError)
// a second read of the same accountId within 60 s opens no tab and returns the first reading
// the result's `lines` holds each page's lines, cut to 300
// the gateway credentials getter is never called for kind "dashboard"
```

Schema tests: a page URL with `http:`, with credentials, or longer than 2048 is refused; an `amount` rule without `unit` is refused; 13 readings and 5 pages are refused.

- [ ] **Step 3: Run them.** → FAIL.

- [ ] **Step 4: Port `cdp.ts` and `pages.ts`**, renaming the messages to the generic ones above and replacing the hard-coded Microsoft host check with "the page's host differs from the requested page's host". Keep the behaviour the ported tests pin (raw CDP over the browser's debugging port, host resolved to an IP first, text via `document.body.innerText`, click by exact text, no typing).

- [ ] **Step 5: Write `rules.ts` and `index.ts`.** Captions are compared after trimming and case-folding. A reading's id is the slug of its label, with `-<n>` when the caption occurs more than once. The 60 second gap is kept per account id in the module.

- [ ] **Step 6: Wire it:** the `dashboard` branch in the schema and in `readGatewayUsage`; `claude.gateway-usage-test` returns `lines` for this kind, and when rules are missing it returns `ok:false` with the error and still the readings that were found.

- [ ] **Step 7: The form** gains **Usage dashboard**: browser host and port, the pages, the optional account to click, the per-page "only between" texts, and the readings list (add, remove; caption, shown name, percent or amount, unit, page). After **Test** it shows the readings found and the page text from the result, each line selectable to fill a rule's caption. Add its cases to `tests/ui-gateway-usage.test.ts`: the form saves the value it shows; **Test** renders returned lines; choosing a line sets the focused rule's `find`.

- [ ] **Step 8: Run everything.** `npm run check` → PASS. README: a bullet on **Usage dashboard** (what it does, that the browser must already be signed in, that nothing is typed and the gateway token is not sent) and a worked example with made-up captions.

- [ ] **Step 9: Commit** (`Read gateway usage from a signed-in dashboard through the shared browser`).

- [ ] **Step 10: Try it for real (owner's yes, on the instance that uses a dashboard-only gateway).** Install the fork there. On that gateway choose **Usage dashboard**, enter that instance's browser address, the two dashboard pages and the account to click, press **Test**, pick the captions from the page text, **Save**. Expected: the card shows the same limits and spend as the dashboard. Then the old private usage plugin can be removed from that instance.
