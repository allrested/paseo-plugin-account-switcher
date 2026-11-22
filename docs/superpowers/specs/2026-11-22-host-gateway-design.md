# Account switching on a host whose Claude is a gateway — design

Date: 2026-11-22. Status: approved by the owner in conversation (short design).

## Intent

On some hosts the Claude CLI itself is set up for a gateway: `settings.json` in the host's Claude
profile carries `ANTHROPIC_BASE_URL` and a token in its `env`. Account switching can be turned on
there, but nothing works afterwards. The owner wants to switch by hand between that gateway and
other accounts added on the host.

## What breaks today

- Every other account fails to be created or used. A managed account, a gateway or a linked
  profile gets its settings copied from the host profile, and the copy refuses settings that
  contain a base URL, token or key helper ("Claude settings contain authentication overrides").
- The host account is never selectable. It becomes ready only after a Claude sign-in check, and a
  gateway has no sign-in. It cannot be switched to, made the default, or named with `/account`.
- Its card reads "Sign in again to retrieve limits.": usage is only asked from Anthropic's
  subscription endpoint.

Launching an agent on the host account already works: the launcher passes it through untouched.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| A | Recognise the host account as a gateway, and strip the gateway settings when copying to other accounts | The host keeps working as it is set up; a copied profile differs from the host's settings by design. |
| B | Ask the user to move the gateway out of `settings.json` into an added gateway account | No code for detection, but it changes a working host setup and the host's own CLI use. |
| C | Keep refusing such hosts and say so | Nothing to build; the feature stays unusable there. |

**Picked: A.**

## Design

1. **The host gateway.** When the host Claude profile's `settings.json` has `env.ANTHROPIC_BASE_URL`
   together with `env.ANTHROPIC_AUTH_TOKEN`, `env.ANTHROPIC_API_KEY` or `apiKeyHelper`, the
   "Current CLI · Claude" account is a *host gateway*: its record carries `baseUrl`, its status is
   ready without a sign-in check, and its card reads "Gateway from Claude settings" with the
   address. Detection runs whenever accounts are listed or the account is checked, so removing
   the settings turns it back into an ordinary host account (status "sign-in not checked").
2. **Copying settings strips instead of refusing.** A profile prepared from the host's settings
   gets them without `apiKeyHelper` and without the authentication keys of `env` (the same list
   that is removed from the process environment). A subscription account added on such a host
   talks to Anthropic. Settings passed explicitly on a command line, and linked profiles, are
   refused as before.
3. **Usage.** The host gateway takes the same Usage setting as an added gateway (Off, Usage
   endpoint, Usage dashboard, External reading). The endpoint kind uses the token from the
   host's settings; without a bearer token there it reports that the credentials are
   unavailable. The subscription usage check is not run for a host gateway.
4. **Not chosen automatically.** Like added gateways, the host gateway is left out of "prefer the
   most available subscription", automatic failover and "move idle agents". Unlike them it can be
   the default for new agents and can be picked in the switcher and with `/account`, because it
   is the host's own account.
5. **Shown plainly.** The host gateway's card has no "Check sign-in" and says that other accounts
   do not inherit the gateway settings.

## Non-goals

- Changing how the host account is launched (it stays a passthrough).
- Gateways set through the daemon's environment or Paseo's provider `env`; those are still
  refused when account switching is turned on (the launcher could not isolate other accounts
  from them).
- Storing or rotating the host gateway's token. It stays in the host's settings.

## Left to the builder

Names, and where the detection is called from.
