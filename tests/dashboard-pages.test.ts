import { describe, expect, it } from "vitest";
import { FakeTab, pageState } from "./helpers/fake-tab";
import { BODY_TEXT, clickAccountExpression, loadPageText, MARK_STALE, READ_STATE, SIGN_IN_NEEDED } from "../server/usage/dashboard/pages";

const PAGE = "https://gateway.example/dashboard";
const SIGN_IN = "https://login.example/authorize?client_id=x";
const options = { accountTile: "viewer@example.com", sleep: async () => {} };

describe("loading a dashboard page", () => {
  it("returns the page's text", async () => {
    const tab = new FakeTab((expr, t) => (expr === READ_STATE ? pageState(t.url) : "page text"));
    await expect(loadPageText(tab, PAGE, options)).resolves.toBe("page text");
    expect(tab.calls).toEqual(["mark", `navigate ${PAGE}`, "state", "body"]);
  });
  it("waits until the page finishes loading, ignoring the previous document", async () => {
    let reads = 0;
    const tab = new FakeTab((expr, t) => expr === READ_STATE ? JSON.stringify({ href: t.url, ready: ++reads < 3 ? "loading" : "complete", stale: reads <= 3 }) : "fresh text");
    await expect(loadPageText(tab, PAGE, options)).resolves.toBe("fresh text");
    expect(tab.calls.filter(c => c === "state")).toHaveLength(4);
  });
  it("clicks the signed-in account once when the browser lands on a sign-in page", async () => {
    let clicked = false;
    const tab = new FakeTab((expr, t) => {
      if (expr === READ_STATE) return pageState(clicked ? t.url : SIGN_IN);
      if (expr === BODY_TEXT) return "page text";
      if (expr === MARK_STALE) return undefined;
      expect(expr).toBe(clickAccountExpression("viewer@example.com"));
      clicked = true;
      return true;
    });
    await expect(loadPageText(tab, PAGE, options)).resolves.toBe("page text");
    expect(tab.calls).toEqual(["mark", `navigate ${PAGE}`, "state", "click", "state", "body"]);
  });
  it("fails without typing when no account tile matches", async () => {
    const tab = new FakeTab(expr => (expr === READ_STATE ? pageState(SIGN_IN) : false));
    await expect(loadPageText(tab, PAGE, options)).rejects.toThrow(SIGN_IN_NEEDED);
    expect(tab.calls.filter(c => c === "click")).toHaveLength(20);
    expect(tab.calls.every(c => c.startsWith("navigate") || c === "mark" || c === "state" || c === "click")).toBe(true);
  });
  it("fails at once on a sign-in page when no account to click is set", async () => {
    const tab = new FakeTab(expr => (expr === READ_STATE ? pageState(SIGN_IN) : true));
    await expect(loadPageText(tab, PAGE, { sleep: async () => {} })).rejects.toThrow(SIGN_IN_NEEDED);
    expect(tab.calls).not.toContain("click");
  });
  it("fails when the click does not lead back to the dashboard", async () => {
    const tab = new FakeTab(expr => (expr === READ_STATE ? pageState(SIGN_IN) : true));
    await expect(loadPageText(tab, PAGE, options)).rejects.toThrow(SIGN_IN_NEEDED);
    expect(tab.calls.filter(c => c === "click")).toHaveLength(1);
  });
  it("fails when the page never loads", async () => {
    const tab = new FakeTab((expr, t) => (expr === READ_STATE ? pageState(t.url, "loading") : ""));
    await expect(loadPageText(tab, PAGE, options)).rejects.toThrow("The dashboard page did not load.");
  });
  it("puts the account text into the click script as data, never as code", () => {
    const script = clickAccountExpression('"); alert(1); ("');
    expect(script).toContain(JSON.stringify('"); alert(1); ("'));
    expect(SIGN_IN_NEEDED).toBe("Sign in to the dashboard in the shared browser.");
  });
});
