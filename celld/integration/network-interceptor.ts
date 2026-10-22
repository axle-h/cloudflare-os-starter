// Takes the place of upstream's `src/network-interceptor.ts` when CFOS_RUNTIME=celld (see
// vitest.config.ts): the same NetworkInterceptor API, with the requests coming from the Workers
// through `celld/mock-upstream.ts` instead of a patched Node fetch.
//
// Upstream's semantics are kept: the most recently installed interceptor sees every request, loopback
// requests pass through to the real address unless `allowLoopback` is false, `allow` lets a request
// use the real network, and the handlers are tried in order. A request nothing answers is recorded
// for `getUnmockedCalls()`, and the Worker sees a 500, as createTestHarness's proxy gives it.
//
// One mock upstream serves the whole test file; the adapter's harness and every installed interceptor
// hold a reference to it, and the last release closes it.

import { startMockUpstream, type MockUpstream } from "../mock-upstream.ts";

export type Handler = (
  url: URL,
  method: string,
  headers: Headers,
  request: Request,
) => Response | null | Promise<Response | null>;

export type AllowRequest = (url: URL, method: string, headers: Headers) => boolean;

type NetworkInterceptorOptions = {
  handlers?: Handler[];
  allow?: AllowRequest;
  allowLoopback?: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Node's own fetch, kept before anything could patch it, for requests that may use the real network.
const realFetch = globalThis.fetch;

/** Interceptors in install order; the last one answers, as the last patch of fetch would. */
const installed: NetworkInterceptor[] = [];
let upstream: Promise<MockUpstream> | undefined;
let references = 0;

async function dispatch(request: Request): Promise<Response | undefined> {
  const interceptor = installed.at(-1);
  if (interceptor === undefined) {
    console.error(`mock-upstream: ${request.method} ${request.url} arrived with no ` +
        "NetworkInterceptor installed; answering 500");
    return undefined;
  }
  return interceptor.answer(request);
}

/**
 * Starts the file's mock upstream, or shares the running one. Pair each call that resolves with
 * `releaseMockUpstream`; one that rejects holds no reference, and the next call starts afresh.
 */
export async function acquireMockUpstream(): Promise<MockUpstream> {
  const starting = upstream ??= startMockUpstream(dispatch);
  references++;
  try {
    return await starting;
  } catch (error) {
    references--;
    if (upstream === starting) upstream = undefined;
    throw error;
  }
}

/** Drops one reference; the last one closes the server. */
export async function releaseMockUpstream(): Promise<void> {
  if (references === 0) throw new Error("releaseMockUpstream() without acquireMockUpstream()");
  if (--references > 0 || upstream === undefined) return;
  const closing = upstream;
  upstream = undefined;
  await (await closing).close();
}

/** Upstream's passthrough: ask for an untransformed body, so the headers Node relays are true. */
function passThrough(request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("accept-encoding", "identity");
  return realFetch(new Request(request, { headers, redirect: "manual" }));
}

export class NetworkInterceptor {
  readonly #handlers: readonly Handler[];
  readonly #allow: AllowRequest | undefined;
  readonly #allowLoopback: boolean;
  #installed = false;
  /** Whether install()'s reference to the mock upstream was taken, once that is known. */
  #acquired: Promise<boolean> = Promise.resolve(false);
  #unmockedCalls: string[] = [];

  constructor({ handlers = [], allow, allowLoopback = true }: NetworkInterceptorOptions = {}) {
    this.#handlers = [...handlers];
    this.#allow = allow;
    this.#allowLoopback = allowLoopback;
  }

  install(): void {
    if (this.#installed) return;
    this.#installed = true;
    installed.push(this);
    // Started here so the harness that follows finds it running; a failure surfaces there.
    this.#acquired = acquireMockUpstream().then(() => true, () => false);
  }

  uninstall(): void {
    if (!this.#installed) return;
    this.#installed = false;
    installed.splice(installed.indexOf(this), 1);
    void this.#acquired.then(acquired => acquired ? releaseMockUpstream() : undefined);
  }

  /** @internal Answers one request that a Worker made, for the mock upstream. */
  async answer(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (this.#allowLoopback && LOOPBACK_HOSTS.has(url.hostname)) return passThrough(request);
    if (this.#allow?.(url, method, request.headers)) return passThrough(request);
    for (const handler of this.#handlers) {
      const response = await handler(url, method, request.headers, request);
      if (response) return response;
    }
    this.#unmockedCalls.push(`${method} ${request.url}`);
    return undefined;
  }

  /** URLs that were neither handled nor local, for asserting nothing escaped. */
  getUnmockedCalls(): string[] {
    return [...this.#unmockedCalls];
  }

  /** Remove and return the recorded unmocked calls containing `substring`. */
  takeUnmockedCalls(substring: string): string[] {
    const taken = this.#unmockedCalls.filter(call => call.includes(substring));
    this.#unmockedCalls = this.#unmockedCalls.filter(call => !call.includes(substring));
    return taken;
  }

  reset(): void {
    this.#unmockedCalls = [];
  }
}
