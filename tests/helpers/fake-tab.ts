import type { CdpTab } from "../../server/usage/dashboard/cdp";
import { BODY_TEXT, MARK_STALE, READ_STATE } from "../../server/usage/dashboard/pages";

/** Records calls as "navigate <url>", "mark", "state", "body" or "click"; `respond` answers evaluate. */
export class FakeTab implements CdpTab {
  calls: string[] = [];
  url = "about:blank";
  closed = false;
  constructor(private readonly respond: (expression: string, tab: FakeTab) => unknown) {}
  async navigate(url: string): Promise<void> { this.calls.push(`navigate ${url}`); this.url = url; }
  async evaluate(expression: string): Promise<unknown> {
    this.calls.push(expression === MARK_STALE ? "mark" : expression === READ_STATE ? "state" : expression === BODY_TEXT ? "body" : "click");
    return this.respond(expression, this);
  }
  async close(): Promise<void> { this.closed = true; }
}
export const pageState = (href: string, ready = "complete") => JSON.stringify({ href, ready });
