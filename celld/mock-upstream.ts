// The outbound network of the Workers under test, for the integration-test adapter (celld plan item
// 0.5): a Node HTTP server that answers each Worker subrequest with upstream's interceptor handlers
// (`scriptedChatCompletions`, `github-fake.ts` and the rest), in the vitest process that owns them.
//
// Under wrangler's createTestHarness a Worker's fetch() comes back through Node, so upstream's
// NetworkInterceptor patches Node's fetch. celld makes outbound requests itself, so the adapter
// bundles `integration/upstream-shim.js` into every Worker instead: it sends each global fetch() here,
// with the URL the Worker asked for encoded in the path (`/u/<encodeURIComponent(url)>`). This
// server decodes it and hands the request, with that URL, to `dispatch`.
//
// - A request no handler answers, and one whose handler throws, gets a synthetic 500, as under
//   createTestHarness, whose proxy turns the interceptor's throw into one; upstream's
//   observer-reverification suite asserts exactly that. `dispatch` records the unanswered ones.
// - A redirect's Location is rewritten to come back here, so a followed redirect stays intercepted;
//   the handler's own value travels in `x-celld-upstream-location`, and the shim restores it, so a
//   Worker using `redirect: "manual"` sees what the handler sent. A redirect can only lead to a URL
//   the mock answers too, which is all the suites' fakes do.
// - Closing the Worker's request (an aborted fetch) aborts the handler's `request.signal`.
//
// It listens on 127.0.0.1 only, on a free port: once celld refuses private fetch targets (plan item
// 1.9), the node needs CELLD_FETCH_PRIVATE_ALLOW to name exactly `mockUpstream.hostPort`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/** The path prefix that carries the Worker's URL. Shared with integration/upstream-shim.js. */
export const UPSTREAM_PATH = "/u/";

/** The status of a request that no handler answered or whose handler threw, as createTestHarness. */
export const FAILED_STATUS = 500;

/**
 * Answers one intercepted request: a Response, or `undefined` when nothing matched (the server then
 * answers 500). The request carries the Worker's own URL, method, headers, body and abort signal.
 */
export type Dispatch = (request: Request) => Promise<Response | undefined>;

export type MockUpstream = {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** `127.0.0.1:<port>`, the entry CELLD_FETCH_PRIVATE_ALLOW needs. */
  hostPort: string;
  close(): Promise<void>;
};

// Hop-by-hop and transport headers that belong to the hop between the Worker and this server.
const DROPPED_REQUEST_HEADERS = new Set([
  "connection", "content-length", "host", "keep-alive", "transfer-encoding", "upgrade",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);
/** Carries a redirect's own Location past the rewrite. Shared with integration/upstream-shim.js. */
export const ORIGINAL_LOCATION = "x-celld-upstream-location";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The URL that `upstreamUrl` reaches through this server. */
export function throughUpstream(origin: string, upstreamUrl: string): string {
  return `${origin}${UPSTREAM_PATH}${encodeURIComponent(upstreamUrl)}`;
}

function decodeTarget(path: string | undefined): URL | undefined {
  if (!path?.startsWith(UPSTREAM_PATH)) return undefined;
  try {
    return new URL(decodeURIComponent(path.slice(UPSTREAM_PATH.length)));
  } catch {
    return undefined;
  }
}

function toRequest(req: IncomingMessage, url: URL, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    // Node's fetch needs this for a streamed body.
    ...(hasBody ? { duplex: "half" } : {}),
    signal,
  } as RequestInit);
}

async function writeResponse(
    res: ServerResponse, response: Response, url: URL, origin: string): Promise<void> {
  const headers: Record<string, string[]> = {};
  response.headers.forEach((value, name) => {
    if (DROPPED_RESPONSE_HEADERS.has(name) || name === ORIGINAL_LOCATION) return;
    // A length the handler set is kept; without a body there is nothing for it to describe.
    if (name === "content-length" && response.body === null) return;
    if (name === "location" && REDIRECT_STATUSES.has(response.status)) {
      headers[ORIGINAL_LOCATION] = [value];
      value = throughUpstream(origin, new URL(value, url).toString());
    }
    (headers[name] ??= []).push(value);
  });
  // Headers.forEach joins repeated headers except set-cookie, which it yields one by one.
  res.writeHead(response.status, response.statusText, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
  await new Promise<void>((resolve, reject) => {
    body.on("error", reject);
    res.on("close", resolve);
    body.pipe(res);
  });
}

/** Starts the server on a free port of 127.0.0.1. */
export async function startMockUpstream(dispatch: Dispatch): Promise<MockUpstream> {
  let origin = "";
  const server: Server = createServer((req, res) => {
    const url = decodeTarget(req.url);
    if (url === undefined) {
      res.writeHead(FAILED_STATUS, { "content-type": "text/plain" });
      res.end(`mock-upstream: ${req.method} ${req.url} does not name an upstream URL ` +
          `(expected ${UPSTREAM_PATH}<encoded URL>)\n`);
      return;
    }
    const aborted = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborted.abort(new Error("The Worker closed the request"));
    });
    void (async () => {
      let response: Response | undefined;
      try {
        response = await dispatch(toRequest(req, url, aborted.signal));
      } catch (error) {
        // A handler that rejects because the Worker went away has no one to answer.
        if (aborted.signal.aborted) {
          res.destroy();
          return;
        }
        console.error(`mock-upstream: the handler for ${req.method} ${url} threw:`, error);
        if (!res.headersSent) res.writeHead(FAILED_STATUS, { "content-type": "text/plain" });
        res.end(`mock-upstream: the handler for ${req.method} ${url} threw: ${error}\n`);
        return;
      }
      if (response === undefined) {
        res.writeHead(FAILED_STATUS, { "content-type": "text/plain" });
        res.end(`Unmocked outbound request: ${req.method} ${url}\n`);
        return;
      }
      try {
        await writeResponse(res, response, url, origin);
      } catch (error) {
        if (!aborted.signal.aborted) {
          console.error(`mock-upstream: the response to ${req.method} ${url} failed:`, error);
        }
        res.destroy();
      }
    })();
  });
  // Long-poll handlers (a `pending` model step) hold a request open for as long as a test needs.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  // Never keep a test process alive on its own.
  server.unref();
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    hostPort: `127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
