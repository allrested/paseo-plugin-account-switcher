import { lookup } from "node:dns/promises";

/** A browser tab driven over the Chrome DevTools Protocol. It can open an address and run a script; it has no way to type. */
export interface CdpTab {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
}
export type OpenTab = () => Promise<CdpTab>;

const HTTP_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 15_000;
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}
interface Waiter { resolve(value: unknown): void; reject(error: Error): void }

/** Opens a new tab in the browser whose remote-debugging port is at `host:port`. */
export function cdpTabOpener(host: string, port: number): OpenTab {
  return async () => {
    // Chrome refuses a debugging request whose Host header is a name, so the name is resolved first.
    const { address } = await lookup(host, { family: 4 });
    const base = `http://${address}:${port}`;
    const res = await fetch(`${base}/json/new?about:blank`, { method: "PUT", signal: timeoutSignal(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The browser's debugging port returned ${res.status}`);
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    const closeTarget = () => fetch(`${base}/json/close/${target.id}`, { signal: timeoutSignal(HTTP_TIMEOUT_MS) }).then(() => undefined, () => undefined);
    let socket: WebSocket;
    try { socket = await connect(target.webSocketDebuggerUrl); }
    catch (error) { await closeTarget(); throw error; }
    const call = rpc(socket);
    return {
      async navigate(url) {
        const result = (await call("Page.navigate", { url })) as { errorText?: string };
        if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      },
      async evaluate(expression) {
        const result = (await call("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
        if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.text ?? "unknown"}`);
        return result.result?.value;
      },
      async close() { socket.close(); await closeTarget(); },
    };
  };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("The browser's debugging connection failed"));
  });
}

function rpc(socket: WebSocket) {
  let nextId = 0;
  const pending = new Map<number, Waiter>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`Browser error: ${message.error.message}`));
    else waiter.resolve(message.result ?? {});
  };
  socket.onclose = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("The browser's debugging connection closed"));
    pending.clear();
  };
  return (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser call ${method} timed out`)); }, CALL_TIMEOUT_MS);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
