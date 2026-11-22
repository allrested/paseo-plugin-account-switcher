import type { CdpTab } from "./cdp";

export const SIGN_IN_NEEDED = "Sign in to the dashboard in the shared browser.";
export const MARK_STALE = "window.__usageStale = true";
export const READ_STATE = "JSON.stringify({ href: location.href, ready: document.readyState, stale: window.__usageStale === true })";
export const BODY_TEXT = "document.body ? document.body.innerText : ''";

const POLL_MS = 500;
const LOAD_ATTEMPTS = 40;
const PICKER_ATTEMPTS = 20;

export interface PageOptions {
  /** The text of an already signed-in account to click when the browser lands on a sign-in page instead. */
  accountTile?: string;
  sleep: (ms: number) => Promise<void>;
}

/** Clicks the account tile that shows `text`. The text is passed as data; the script never types. */
export function clickAccountExpression(text: string): string {
  return `(() => {
  const text = ${JSON.stringify(text)};
  const shown = [...document.querySelectorAll("[data-test-id],[role=button],button,a,.table")]
    .filter((el) => el.innerText && el.innerText.includes(text));
  // The account's own tile, not a wrapper around several accounts or a button that merely mentions it.
  const tile = shown.find((el) => el.innerText.trim() === text) || shown.sort((a, b) => a.innerText.length - b.innerText.length)[0];
  if (!tile) return false;
  tile.click();
  return true;
})()`;
}

async function poll<T>(attempts: number, sleep: PageOptions["sleep"], check: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value !== null) return value;
    await sleep(POLL_MS);
  }
  return null;
}

function loadedHost(tab: CdpTab, options: PageOptions, wanted?: string): Promise<string | null> {
  return poll(LOAD_ATTEMPTS, options.sleep, async () => {
    const state = JSON.parse(String(await tab.evaluate(READ_STATE))) as { href: string; ready: string; stale?: boolean };
    const host = new URL(state.href).host;
    if (state.stale === true || state.ready !== "complete" || host === "") return null;
    if (wanted !== undefined && host !== wanted) return null;
    return host;
  });
}

/**
 * Opens `url` and returns the page's visible text. A page that ends on another host is a sign-in page:
 * with `accountTile` the matching account is clicked once, otherwise the read fails.
 */
export async function loadPageText(tab: CdpTab, url: string, options: PageOptions): Promise<string> {
  const wanted = new URL(url).host;
  await tab.evaluate(MARK_STALE);
  await tab.navigate(url);
  const host = await loadedHost(tab, options);
  if (host === null) throw new Error("The dashboard page did not load.");
  if (host !== wanted) {
    if (!options.accountTile) throw new Error(SIGN_IN_NEEDED);
    const tile = options.accountTile;
    const clicked = await poll(PICKER_ATTEMPTS, options.sleep, async () => (await tab.evaluate(clickAccountExpression(tile))) === true ? true : null);
    if (clicked === null) throw new Error(SIGN_IN_NEEDED);
    if ((await loadedHost(tab, options, wanted)) === null) throw new Error(SIGN_IN_NEEDED);
  }
  return String(await tab.evaluate(BODY_TEXT));
}
