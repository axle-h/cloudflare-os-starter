// The adapter's own checks (celld plan item 0.5): what upstream's suites rely on from the harness
// and the network interception, proven through a probe Worker on celld, so a suite that fails is
// failing on celld, not on the adapter. celld/integration/run.ts runs this file before the suites.

import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { scriptedChatCompletions } from "../../cloudflare-os/packages/integration-tests/src/mock-model.ts";
import {
  connect, logIn, nextUsernames, signUp,
} from "../../cloudflare-os/packages/integration-tests/src/rpc-client.ts";
import { startCelldHarness, type Harness } from "./harness.ts";
import { NetworkInterceptor, type Handler } from "./network-interceptor.ts";

const PROBE = "adapter-probe";
const model = scriptedChatCompletions([{ text: "scripted reply" }]);
const aborted = Promise.withResolvers<string>();

const handlers: Handler[] = [
  model.handler,
  async (url, method, headers, request) => {
    if (url.hostname !== "api.example.test") return null;
    switch (url.pathname) {
      case "/echo":
        return Response.json({
          url: url.toString(), method, header: headers.get("x-probe"), body: await request.text(),
        }, { headers: { "x-upstream": "yes" } });
      case "/redirect":
        return new Response(null, { status: 302, headers: { location: "/after-redirect?step=2" } });
      case "/sized":
        return new Response("sized", { headers: { "content-length": "5" } });
      case "/after-redirect":
        return new Response(`landed ${url.search}`);
      case "/throws":
        throw new Error("the handler failed on purpose");
      case "/pending":
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted.resolve("aborted");
            reject(request.signal.reason);
          }, { once: true });
        });
      default:
        return null;
    }
  },
];
const network = new NetworkInterceptor({ handlers });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startCelldHarness({
    gatekeepers: [{ binding: "PROBE", dir: join(import.meta.dirname, "fixtures/probe") }],
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
  } finally {
    network.uninstall();
  }
});

type Probe = {
  status?: number; url?: string; redirected?: boolean; contentType?: string | null;
  location?: string | null; contentLength?: string | null; cloneUrl?: string; body?: string;
  error?: string;
};

async function probe(url: string, init?: RequestInit, timeoutMs?: number): Promise<Probe> {
  const response = await harness.fetchWorker(PROBE, "http://probe.test/fetch", {
    method: "POST", body: JSON.stringify({ url, init, timeoutMs }),
  });
  expect(response.status).toBe(200);
  return await response.json() as Probe;
}

it("dispatches fetchWorker to the named Worker with the caller's URL, method and body", async () => {
  const response = await harness.fetchWorker(PROBE, "http://probe.test/echo?q=1", {
    method: "PUT", body: "payload", headers: { "x-probe": "header" },
  });
  expect(await response.json()).toEqual({
    url: "http://probe.test/echo?q=1", method: "PUT", header: "header", body: "payload",
  });
  await expect(harness.fetchWorker("no-such-worker", "/")).rejects.toThrow(/No Worker named/);
});

it("serves unrouted requests from the Workshop, as upstream's primary", async () => {
  const response = await harness.server.fetch("/");
  expect(response.status).toBeLessThan(500);
});

it("hands a Worker's fetch to the handlers with its own URL, method, headers and body", async () => {
  const result = await probe("https://api.example.test/echo?x=1", {
    method: "POST", headers: { "x-probe": "sent" }, body: "hello",
  });
  expect(result.status).toBe(200);
  expect(result.url).toBe("https://api.example.test/echo?x=1");
  expect(JSON.parse(result.body!)).toEqual({
    url: "https://api.example.test/echo?x=1", method: "POST", header: "sent", body: "hello",
  });
});

it("streams a scripted model's SSE reply to the Worker", async () => {
  const result = await probe("https://api.cloudflare.com/client/v4/accounts/a/ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  expect(result.status).toBe(200);
  expect(result.contentType).toBe("text/event-stream");
  expect(result.body).toContain("scripted reply");
  expect(result.body).toContain("data: [DONE]");
  expect(model.requests).toHaveLength(1);
});

it("keeps a Content-Length the handler set", async () => {
  expect(await probe("https://api.example.test/sized"))
      .toMatchObject({ status: 200, body: "sized", contentLength: "5" });
});

it("follows a handler's redirect through the handlers", async () => {
  expect(await probe("https://api.example.test/redirect"))
      .toMatchObject({ status: 200, body: "landed ?step=2" });
});

it("shows a manual redirect with the handler's own Location and the Worker's URL", async () => {
  expect(await probe("https://api.example.test/redirect", { redirect: "manual" })).toMatchObject({
    status: 302,
    location: "/after-redirect?step=2",
    url: "https://api.example.test/redirect",
  });
});

// Not in celld's plan yet: celld's Response.clone() throws "Cannot clone a streaming response before
// consumption" on a fetched body, and its clones carry no `url` or `redirected`. workerd tees the
// body and keeps both. The shim keeps its URL on a clone exactly where the runtime does, so this
// passes once celld's clone() does; then make it an `it`.
it.fails("a clone of a fetched response keeps its URL (celld clone() gap)", async () => {
  expect(await probe("https://api.example.test/echo"))
      .toMatchObject({ cloneUrl: "https://api.example.test/echo" });
});

// celld plan item 1.20: after a followed redirect, `response.url` is the final URL and `redirected`
// is true, as in workerd.
it("reports the final URL of a followed redirect", async () => {
  expect(await probe("https://api.example.test/redirect")).toMatchObject({
    redirected: true, url: "https://api.example.test/after-redirect?step=2",
  });
});

it("answers 500 to a request no handler matches, and records it", async () => {
  const target = "https://unmatched.example.test/path";
  expect(await probe(target)).toMatchObject({ status: 500 });
  expect(network.takeUnmockedCalls(target)).toEqual([`GET ${target}`]);
});

it("answers 500 when a handler throws", async () => {
  expect(await probe("https://api.example.test/throws")).toMatchObject({ status: 500 });
});

it("aborts the handler's request when the Worker aborts its fetch", async () => {
  const result = await probe("https://api.example.test/pending", undefined, 300);
  expect(result.error).toMatch(/abort|timeout/i);
  expect(await aborted.promise).toBe("aborted");
});

it("redeploys the Workshop with the new config, on the same URL, keeping storage", async () => {
  const [username] = nextUsernames("adapter");
  const before = connect(harness.url);
  try {
    using api = await signUp(before, username);
    expect(await api.amIAdmin()).toBe(false);
  } finally {
    before[Symbol.dispose]();
  }
  const url = harness.url.toString();

  // The Workshop reads ADMINS on every call, so the new config shows as soon as it runs.
  await harness.redeployWorkshop(config => {
    const admins = Array.isArray(config.vars?.ADMINS) ? config.vars.ADMINS : [];
    config.vars = { ...config.vars, ADMINS: [...admins, username] };
  });

  expect(harness.url.toString()).toBe(url);
  const after = connect(harness.url);
  try {
    // logIn proves the account survived; amIAdmin that the new config took effect.
    using api = await logIn(after, username);
    expect(await api.amIAdmin()).toBe(true);
  } finally {
    after[Symbol.dispose]();
  }
});

it("let nothing else escape", () => {
  expect(network.getUnmockedCalls()).toEqual([]);
});
