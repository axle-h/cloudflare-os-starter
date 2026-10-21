// Health check for the e2e node: `GET /` returns HTML, then `ping()` round-trips over the Cap'n
// Web session at `ws://…/api`. Both retry until one deadline passes.
//
// Usage: node celld/e2e/health.ts ORIGIN [TIMEOUT_SECONDS]   (default 60)

import { createRequire } from "node:module";
import { join } from "node:path";

/** The one `PublicApi` method (cos:workshop-shared/src/api.ts) the check calls. */
type Session = { ping(): Promise<void>; [Symbol.dispose](): void };

// The capnweb the app itself speaks, resolved from the shared API package.
const require = createRequire(join(import.meta.dirname,
    "../../cloudflare-os/packages/workshop-shared/package.json"));
const { newWebSocketRpcSession } =
    require("capnweb") as { newWebSocketRpcSession(url: string): Session };

const [origin, timeoutArg = "60"] = process.argv.slice(2);
if (!origin) throw new Error("usage: node celld/e2e/health.ts ORIGIN [TIMEOUT_SECONDS]");
const deadline = Date.now() + Number(timeoutArg) * 1000;
const RETRY_MS = 1000;

function remaining(): number {
  return Math.max(0, deadline - Date.now());
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Retries `attempt` until it succeeds; at the deadline, prints the last failure and exits 1. */
async function retry<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await withTimeout(attempt(), remaining(), what);
    } catch (error) {
      if (remaining() <= RETRY_MS) {
        console.log(`FAIL ${what}: ${String(error)}`);
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }
}

await retry(`GET ${origin}/`, async () => {
  const response = await fetch(`${origin}/`);
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (response.status !== 200 || !type.startsWith("text/html")) {
    throw new Error(`status ${response.status}, content-type ${JSON.stringify(type)}: ${body.slice(0, 200)}`);
  }
});
console.log(`PASS GET ${origin}/ returns HTML`);

const wsUrl = origin.replace(/^http/, "ws") + "/api";
await retry(`ping() over ${wsUrl}`, async () => {
  const api = newWebSocketRpcSession(wsUrl);
  try {
    await api.ping();
  } finally {
    api[Symbol.dispose]();
  }
});
console.log(`PASS ping() over ${wsUrl}`);
