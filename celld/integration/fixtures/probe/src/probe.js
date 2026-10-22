// The adapter self-test's probe Worker. POST /fetch takes {url, init?, timeoutMs?}, makes that global
// fetch() and answers what came back; GET /echo answers the URL and headers it was called with.
import { WorkerEntrypoint } from "cloudflare:workers";

// The Workshop binds every harness Worker as a gatekeeper, at this entrypoint.
export class GatekeeperVendor extends WorkerEntrypoint {}

function cloneUrl(response) {
  try {
    return response.clone().url;
  } catch (error) {
    return `clone() threw: ${error}`;
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      return Response.json({
        url: request.url,
        method: request.method,
        header: request.headers.get("x-probe"),
        body: await request.text(),
      });
    }
    if (url.pathname !== "/fetch") return new Response("not found", { status: 404 });
    const { url: target, init, timeoutMs } = await request.json();
    try {
      const response = await fetch(target, {
        ...init,
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      return Response.json({
        status: response.status,
        url: response.url,
        redirected: response.redirected,
        contentType: response.headers.get("content-type"),
        location: response.headers.get("location"),
        contentLength: response.headers.get("content-length"),
        cloneUrl: cloneUrl(response),
        body: await response.text(),
      });
    } catch (error) {
      return Response.json({ error: String(error) });
    }
  },
};
