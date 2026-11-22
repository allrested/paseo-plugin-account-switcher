# Usage for Claude gateways — design

Date: 2026-11-22. Status: approach picked by the owner; the written design waits for approval.

## Intent

A Claude gateway in Accounts (a base URL plus an API token) shows no usage today: the card says
"Gateway configured" and nothing else. The owner wants a gateway to show how much is used and
left, like a subscription does, for two kinds of gateway:

- one that answers a JSON usage request with the gateway's own token (BDDev,
  `api.bddevlab.online`);
- one that has no JSON usage API and shows usage only on a dashboard page (for example a team proxy whose dashboard sits behind
  company sign-in).

It has to be flexible: a new JSON gateway should need a filled-in form, not a code change.

## Goals

- Each gateway has an optional usage reader, set in Accounts, of one of three kinds: **Usage endpoint**,
  **Usage dashboard** or **External reading** (the owner's names, 2026-11-22).
- **Usage endpoint** is a custom usage endpoint the user describes. BDDev's values are one
  button, "Fill in for BDDev", inside that form.
- **Usage dashboard** opens a signed-in dashboard in the shared browser and gathers usage from
  the page, by rules the user sets. No second plugin is needed for a dashboard-only gateway (the owner's decision, after the first version of this design kept it outside).
- **External reading** is like the dashboard kind, but only reads a file another tool produced.
- The account card and the agent's account switcher show the reading: amounts (credits, USD,
  requests, tokens) and percent windows.
- The same reading appears in Paseo's Usage view.
- A gateway without a reader behaves exactly as today.

## Non-goals

- Dashboard code written for one gateway. The dashboard reader is general; a page it cannot
  describe (numbers drawn in a chart, values not next to a caption) uses the external reading.
- Typing a password or completing a sign-in. The reader only uses a browser that is already
  signed in.
- Using a gateway's usage for automatic choices. Gateways stay out of "prefer the most available
  subscription", automatic failover, "move idle agents" and the default account, as today.
- Gateways for Codex.

## Anti-goals

- The gateway token sent anywhere but the gateway's own origin.
- A token, or any part of a response that is not a mapped number or label, shown in the UI, an
  error message or a log.
- A wrong mapping shown as a confident number: a field that is missing or not a number yields
  "unavailable" with the field's name, never 0.

## Constraints found

- A gateway account is a registry record (`source: "gateway"`, `baseUrl`) plus
  `accounts/<id>/gateway.json` (`base_url`, `api_token`, owner-only). `gatewayEnvironment()` in
  `server/claude-profiles.ts` is the one checked way to read the token.
- The usage scheduler (`server/usage/index.ts`, described in `server/usage/README.md`) polls every
  five minutes, every minute while a list is visible, keeps a cache in `usage-cache.json`, backs
  off, and marks a failed read `stale`. It takes its accounts from the controller, which filters
  gateways out (`server/controller.ts`, `readQuotaAccounts`).
- A reading is a `UsageSnapshot` (`shared/contracts.ts`): percent windows only. Amounts have no
  place in it today.
- The Usage view is fed by `server/paseo-usage.ts`; `discoverAccounts` accepts only `managed` and
  `linked` accounts and needs an `identityKey`, which a gateway does not have. Paseo's own
  `UsageReport` already has `balances` (used, remaining, limit; unit `usd`, `credits`, `requests`
  or `tokens`) next to `windows`.
- Prior art for the JSON kind: `paseo-plugins/bddevlab-usage-source/server/usage.ts` calls
  `GET https://api.bddevlab.online/api/usage/token/` with `Authorization: Bearer`, reads
  `data.total_used`, `data.total_granted`, `data.total_available` (each divided by 100,000 to give
  credits), `data.name` and `data.unlimited_quota`. Eleven other usage sources in Paseo follow
  the same pattern: one URL, a bearer token, a few fields.
- Prior art for the dashboard case: a private plugin of the owner reads a
  gateway's dashboard pages through a signed-in shared browser, every five minutes. Its pages are
  plain caption-then-value text (a caption line such as a window's name or `REQUESTS`, then a
  line with `99%` or `2,059`), which is what the general reader's rules describe.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | A usage reader per gateway: a configurable JSON endpoint, and an external reading another tool writes to a file | New JSON gateways need no code. A dashboard-only gateway still needs its own small reader. |
| B | A generic page reader in Accounts (page URL plus text patterns, through the shared browser) | Looks most flexible, but puts browser driving and sign-in inside the account plugin, and every dashboard redesign breaks a user's setting. |
| C | A code module per gateway | Fastest to build; every new gateway is a code change and a release. |

**Picked by the owner: A**, extended with a general dashboard reader inside this plugin (B in a
bounded form: caption-and-number rules, no free-form patterns), so no second plugin is needed.

## Design

### The reader setting

Stored on the gateway's registry record as `usage` (no secret in it); absent means off.

**Kind `endpoint`** (Usage endpoint):

- `path`: the endpoint, as a path starting with `/` with an optional query. A full address is
  accepted in the form when its origin is the gateway's, and stored as its path. The request
  goes to the origin of the account's `baseUrl` and nowhere else (my call: this is what keeps
  the token on the gateway; a usage API on another host is not supported in this version).
- `fields`: dot paths into the JSON reply (`data.total_used`; a numeric segment indexes an
  array). All optional, at least one of the first four required: `used`, `limit`, `remaining`,
  `usedPercent`, `resetsAt`, `plan`, `unlimited`.
- `unit`: `credits`, `usd`, `requests` or `tokens`. `divisor`: a positive number the three
  amounts are divided by (default 1).
- `label`: the row's name (default "Balance").

Request: `GET`, `Authorization: Bearer <token>` and `Accept: application/json`, 15 second
timeout, redirects refused, at most 256 KB read. Numbers may arrive as numbers or numeric
strings. `resetsAt` may be an ISO time or epoch seconds or milliseconds.

**Kind `file`** (External reading):

- `path`: an absolute path to a JSON file another tool keeps up to date, holding
  `{ "fetchedAt": <ISO time>, "report": <Paseo UsageReport> }`. Only an `available` report's
  `planLabel`, `windows` and `balances` are used. The file must be a regular file of at most
  256 KB. A `fetchedAt` older than 30 minutes makes the reading `stale`.

### "Fill in for BDDev"

`path: /api/usage/token/`; `used: data.total_used`, `limit: data.total_granted`,
`remaining: data.total_available`, `plan: data.name`, `unlimited: data.unlimited_quota`;
`divisor: 100000`; `unit: credits`; `label: Credits`. The button fills the Usage endpoint form with these values; the
form shows it first when the gateway's host is `api.bddevlab.online`.

### What a reading becomes

`UsageSnapshot` gains `balances`: `{ id, label, used, remaining, limit, unit }`, each amount a
number or null.

- Endpoint kind: one balance when any of `used`, `limit`, `remaining` is mapped; a missing one of the
  three is worked out from the other two when both are present. One window (`usedPercent`,
  `resetsAt`) when `usedPercent` is mapped. `unlimited: true` gives a balance with no limit and
  the detail "Unlimited".
- Dashboard kind: one window per percent reading and one balance per amount reading (the amount
  is the `used` figure).
- File kind: the report's windows and balances, converted to this plugin's shapes.
- Status: `ok`; `stale` when a later read fails or the file is old (the last good reading stays);
  `unavailable` with a plain reason otherwise: "The gateway refused the token (401).", "The
  usage reply has no number at data.total_used.", "The usage file is missing." A gateway never
  gets `needs_auth`: there is no sign-in to offer.

### Where it runs

The gateway reader is a third collector beside Claude's and Codex's, behind the existing
scheduler, so it gets the same cadence, cache, backoff and `stale` handling. The controller
passes gateways that have a reader to the scheduler; those without stay filtered out. The
identity checks the scheduler does for subscriptions do not apply to a gateway.

### Setting it

- `claude.gateway-usage-set { accountId, usage | null }` saves or clears the setting and
  refreshes that account's reading.
- `claude.gateway-usage-test { accountId, usage }` runs the reader once without saving and
  returns the reading or the reason it failed, so the form can show the result before saving.
- In Accounts, a gateway's **Manage** section gets **Usage**: Off, Usage endpoint, Usage
  dashboard, External reading. Each form has **Test** and **Save**. The endpoint form has the
  address, the field paths, unit, divisor, label and "Fill in for BDDev". The dashboard form has
  the browser address, the pages, the optional account to click, and the list of readings, with
  the page text from the last **Test** beside it.

### Showing it

- The account card and the switcher show a gateway's reading with the existing quota summary,
  which gains a balance row: label, "412 of 1,000 credits left" (or "38.20 USD used" when there
  is no limit), and a bar when a limit is known. A gateway without a reader keeps today's
  "Gateway configured" text.
- Usage view: `discoverAccounts` also returns gateways that have a reader, keyed by a hash of the
  account id, labelled with the gateway's label; windows and balances map onto Paseo's report.
  Global list only, like the managed accounts (my call).

### Kind `dashboard` (Usage dashboard: a signed-in page read through the shared browser)

For a gateway whose usage is only on a web page. Nothing here is specific to one gateway: the
reader is a general "find this label on the page, take the number next to it". The browser
driving is ported from a private plugin (`server/cdp.ts`, `pages.ts`, no dependencies);
its gateway-specific parser is not, so this public repository carries no organisation's details.

Setting:

- `browser`: `host` and `port` of the shared browser's remote-debugging address (default
  `127.0.0.1:9222`, this instance's shared browser).
- `pages`: one to four `https` addresses to open. They may be on another host than the gateway:
  the gateway token is not used and not sent by this kind.
- `accountTile` (optional): the text of the account to click when the browser lands on a
  sign-in account chooser instead of the page. The reader clicks an already signed-in account;
  it never types.
- `readings`: one to twelve rules, each `{ label, find, type, unit?, page? }`:
  - `find`: the text of a line on the page (the tile's or row's caption, for example `EST. COST`
    or `Weekly · all models`), compared without regard to case and surrounding spaces;
  - `type`: `percent` (becomes a window) or `amount` (becomes a balance, with `unit`);
  - `page`: which of `pages` (default the first);
  - `label`: the name shown in Accounts.
- `between` (optional, per page): `{ after?, before? }` line texts; only the lines between them
  are searched (for a page that lists several teams).

How a page is read: the page's visible text, split into non-empty lines. For a rule, find each
line equal to `find`; the value is the first of the next three lines that is a number: `99%`,
`2,059`, `$1,234.50`, `26.7K`, `2.2M`. When the same caption occurs several times (one block per
account), each occurrence is a separate reading, named after the nearest email address above it
when there is one, otherwise numbered. For a percent, a phrase `resets in 1d 18h` (days, hours,
minutes) or an ISO time within the two lines after the value sets the window's reset time.

Failures, `unavailable` or `stale` with an earlier reading: "Sign in to the dashboard in the
shared browser." (the page ended on another host and no account tile matched), "No line
'<find>' on the page." (naming the first rule that found nothing; rules that did find something
are still shown by **Test**), "The browser is unreachable at <host>:<port>." A dashboard read
is not started more often than once a minute, whatever the scheduler asks. The tab the reader
opens is closed after every read.

**Test** for this kind also returns the page's lines (at most 300 per page), so the form can
show the page text and the user can pick the captions to use.

## Details settled after a builder's read (my calls)

- **Cache and identity.** The scheduler keeps a cache and a last good reading only for accounts
  with an identity key, and a gateway has none. A gateway with a reader is given the fixed
  identity `gateway:<account id>` for the scheduler's purposes, so its reading survives a restart
  and a failed poll shows the last good one as `stale`. The scheduler may be changed for this.
  Identity verification and credential-version checks are skipped for gateways.
- **Errors.** The gateway collector supplies its own message; the scheduler shows it as given.
  A 401 or 403 from a gateway is `unavailable` (the scheduler's rule "401 means `needs_auth`"
  stays for subscriptions) and is retried on the normal cadence. A 429 keeps the existing backoff.
- **`balances` is optional** in `UsageSnapshot`; absent means none. Cache entries and clients
  that predate it keep parsing.
- **One scheduler.** Gateways go through the same scheduler and account list as subscriptions.
  The account type the scheduler takes gains a gateway form (no CLI command, no profile home);
  its shape is the builder's.
- **Not gated on the Claude CLI.** A gateway's reading shows even when the Claude CLI is
  unavailable or not integrated: the reader needs neither.
- **Usage view mapping.** Balances map one to one, units unchanged. A reading with balances and
  no windows is valid. Unlimited is a balance with no limit and no remaining, plus a detail row
  "Unlimited". The account key is `hashAccountKey("gateway:" + account id)`.
- **The two views** are `client/account-card.tsx` (line 96 hides the quota summary for gateways)
  and `client/switcher.tsx` (line 73 does the same). Both show it when the gateway has a reader.
- **`usage` is part of the account the client receives** (`AccountSchema`, optional). It holds a
  path and field names, never the token. The registry stays at version 1.
- **Test needs a saved gateway.** `claude.gateway-usage-test` takes an existing account and reads
  the token only through `gatewayEnvironment()`.

## Left to the builder

- Module and function names, and how the collector plugs into the scheduler.
- The exact wording and layout of the form and the balance row, following the existing
  components.
- Number formatting per unit.
- Whether `usage` on the stored account needs a registry version step (the registry is at
  version 1 and already holds fields upstream ignores).
