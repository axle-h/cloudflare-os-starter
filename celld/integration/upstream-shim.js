// Bundled into every Worker the integration-test adapter runs (celld plan item 0.5), ahead of the
// Worker's own main module: it sends each global fetch() to `celld/mock-upstream.ts`, which answers
// with the test's NetworkInterceptor handlers.
//
// This takes the place of what createTestHarness does for upstream's suites, routing a Worker's
// outbound fetch() back through the Node process. The request keeps its method, headers, body,
// signal and redirect mode; the Worker's URL travels in the path. What comes back is made to look
// as if the Worker had reached that URL itself:
// - `response.url` is the Worker's URL (after a followed redirect, the URL celld reports, decoded),
//   on the response and, where the runtime's clone() keeps a URL, on its clones;
// - a redirect's `Location` is the value the handler gave, not the mock's rewrite of it.
//
// Only global fetch() is routed. Service bindings, Durable Object stubs and `ctx.exports` do not use
// it, and a Dynamic Worker reaches the network only through the `globalOutbound` its loader gives it,
// which is Workshop code calling this fetch. TLS, DNS and celld's outbound policy are bypassed.
//
// Test-only: it is never part of a deployment.

const UPSTREAM_PATH = "/u/";
/** Set by mock-upstream.ts on a redirect: the handler's own Location. Shared with it. */
const ORIGINAL_LOCATION = "x-celld-upstream-location";

// The URL and `redirected` a response reports, where the shim changed them. workerd's Response has
// read-only accessors on its prototype, which are overridden to consult these; celld's has writable
// instance properties, which are assigned. A clone keeps the override only where the runtime's own
// clone() keeps a URL, so the shim neither hides nor adds a difference in clone().
const urls = new WeakMap();
const redirects = new WeakMap();
let accessors = false;

function override(response, url, redirected) {
  urls.set(response, url);
  redirects.set(response, redirected);
  if (!accessors) {
    response.url = url;
    response.redirected = redirected;
  }
}

function installResponseOverrides() {
  const proto = Response.prototype;
  const url = Object.getOwnPropertyDescriptor(proto, "url");
  const redirected = Object.getOwnPropertyDescriptor(proto, "redirected");
  if (url?.get && redirected?.get) {
    if (!url.configurable || !redirected.configurable) {
      throw new Error("upstream-shim: Response.prototype.url is a fixed accessor");
    }
    accessors = true;
    Object.defineProperty(proto, "url", {
      ...url,
      get() { return urls.has(this) ? urls.get(this) : url.get.call(this); },
    });
    Object.defineProperty(proto, "redirected", {
      ...redirected,
      get() { return redirects.has(this) ? redirects.get(this) : redirected.get.call(this); },
    });
  }
  const clone = proto.clone;
  proto.clone = function () {
    const copy = clone.call(this);
    // The runtime's own clone() read: blank means it does not carry the URL over.
    const native = accessors ? url.get.call(copy) : copy.url;
    if (urls.has(this) && native !== "") override(copy, urls.get(this), redirects.get(this));
    return copy;
  };
}

/** Route this isolate's global fetch() through the mock upstream at `origin`. */
export function installUpstreamShim(origin) {
  const prefix = `${origin}${UPSTREAM_PATH}`;
  const realFetch = globalThis.fetch;
  installResponseOverrides();

  function workerUrl(url) {
    return url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length)) : url;
  }

  globalThis.fetch = async function fetch(input, init) {
    const request = new Request(input, init);
    let response = await realFetch(new Request(prefix + encodeURIComponent(request.url), request));
    const url = workerUrl(response.url || request.url);
    const redirected = response.redirected;
    const location = response.headers.get(ORIGINAL_LOCATION);
    if (location !== null) {
      // Fetched responses have immutable headers, so the redirect is rebuilt with its own Location.
      const headers = new Headers(response.headers);
      headers.delete(ORIGINAL_LOCATION);
      headers.set("location", location);
      response = new Response(response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    }
    override(response, url, redirected);
    return response;
  };
}
