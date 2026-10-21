// A scripted OpenAI-compatible model server for the celld e2e harness, on 127.0.0.1:11434
// (MOCK_LLM_PORT overrides the port).
//
// Cloudflare OS reaches it as an "Other Ollama…" provider with model `scripted`. Agent requests
// consume a queue of steps that a test posts to /__script; once the queue is empty, each agent
// request answers `{ text: "ok" }`. Quick-model requests (chat titles, gadget titles, binding
// names) never consume the queue: upstream's `scriptedChatCompletions` answers them from its own
// table, so titles are deterministic.
//
// Model surface:
//   GET  /api/tags              Ollama's model list
//   GET  /v1/models             OpenAI's model list
//   POST /v1/chat/completions   SSE with `"stream": true`, one JSON completion otherwise
// Control surface:
//   POST /__script    append steps: one step or an array of
//                     { text } | { toolCall: { id, name, arguments } } | { error }
//                     where `error` is a message (status 500) or { status, message }
//   GET  /__requests  the requests received since the last reset, oldest first; only the last
//                     1000 are kept
//   POST /__reset     clear the queue and the recorded requests
// Every error, scripted or not, is an OpenAI error body: { "error": { "message", "type" } }.
//
// Usage: node celld/mock-llm.ts [--self-test]
//   --self-test  start on a free port, exercise every endpoint, and exit 0 on success.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  scriptedChatCompletions,
  type ChatCompletionStep,
} from "../cloudflare-os/packages/integration-tests/src/mock-model.ts";

/** The one model name, in model lists and in every completion. */
export const MODEL_ID = "scripted";
const HOST = "127.0.0.1";
const DEFAULT_PORT = 11434;
const DEFAULT_STEP: ChatCompletionStep = { text: "ok" };
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RECORDED = 1000;

export type RecordedRequest = {
  method: string;
  path: string;
  /** "agent" consumed a step, a quick-model kind such as "thread-title" did not. */
  kind: string;
  body: unknown;
};

/** A request the mock refuses, answered with an OpenAI error body. */
class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorType(status: number): string {
  if (status === 400 || status === 413) return "invalid_request_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "api_error";
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message, type: errorType(status) } }, { status });
}

/** Turns one JSON step from /__script into upstream's step type, or throws. */
function parseStep(raw: unknown): ChatCompletionStep {
  const invalid = (message: string) => new RequestError(400, message);
  if (typeof raw !== "object" || raw === null) throw invalid("a step must be an object");
  const step = raw as Record<string, unknown>;
  const keys = Object.keys(step);
  if (keys.length !== 1) throw invalid(`a step has exactly one key, got ${JSON.stringify(keys)}`);
  if ("text" in step) {
    if (typeof step.text !== "string") throw invalid("text must be a string");
    return { text: step.text };
  }
  if ("toolCall" in step) {
    const call = step.toolCall as Record<string, unknown> | null;
    if (typeof call?.id !== "string" || typeof call.name !== "string"
        || typeof call.arguments !== "object" || call.arguments === null
        || Array.isArray(call.arguments)) {
      throw invalid("toolCall needs a string id and name and an object of arguments");
    }
    return { toolCall: { id: call.id, name: call.name, arguments: call.arguments as Record<string, unknown> } };
  }
  if ("error" in step) {
    if (typeof step.error === "string") return { error: { status: 500, message: step.error } };
    const error = step.error as Record<string, unknown> | null;
    if (typeof error?.message !== "string") throw invalid("error must be a message or { status, message }");
    const status = error.status ?? 500;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) {
      throw invalid("error.status must be an HTTP error status");
    }
    return { error: { status, message: error.message } };
  }
  throw invalid(`unknown step ${JSON.stringify(keys[0])}`);
}

type Chunk = {
  id: string;
  model: string;
  choices: { delta: { content?: string; tool_calls?: ToolCallDelta[] }; finish_reason: string | null }[];
  usage?: unknown;
};
type ToolCallDelta = { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };

/** The chunks of an SSE completion, without the closing `[DONE]`. */
function chunks(sse: string): Chunk[] {
  return sse.split("\n")
    .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice("data: ".length)) as Chunk);
}

/** Folds an SSE completion into the one object a non-streamed request expects. */
function collect(parts: Chunk[]): unknown {
  let content: string | null = null;
  let finishReason: string | null = null;
  let usage: unknown;
  const toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[] = [];
  for (const chunk of parts) {
    usage = chunk.usage ?? usage;
    for (const choice of chunk.choices) {
      finishReason = choice.finish_reason ?? finishReason;
      if (choice.delta.content !== undefined) content = (content ?? "") + choice.delta.content;
      for (const call of choice.delta.tool_calls ?? []) {
        const slot = toolCalls[call.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        slot.id += call.id ?? "";
        slot.function.name += call.function?.name ?? "";
        slot.function.arguments += call.function?.arguments ?? "";
      }
    }
  }
  const message = toolCalls.length
    ? { role: "assistant", content, tool_calls: toolCalls }
    : { role: "assistant", content };
  return {
    id: parts[0]?.id,
    object: "chat.completion",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, `request body over ${MAX_BODY_BYTES} bytes`);
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RequestError(400, `the body is not JSON: ${String(error)}`);
  }
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export type MockLlm = {
  server: Server;
  origin: string;
  close(): Promise<void>;
};

export type MockLlmOptions = {
  /** 0 picks a free port. */
  port?: number;
  /** How many requests /__requests keeps. */
  maxRecorded?: number;
};

function portFromEnv(): number {
  const raw = process.env.MOCK_LLM_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MOCK_LLM_PORT=${raw} is not a port`);
  return port;
}

/** Starts the mock on HOST. */
export async function startMockLlm(options: MockLlmOptions = {}): Promise<MockLlm> {
  const { port = portFromEnv(), maxRecorded = MAX_RECORDED } = options;
  let queue: ChatCompletionStep[] = [];
  let requests: RecordedRequest[] = [];
  let completionSeq = 0;

  function record(request: RecordedRequest): void {
    requests.push(request);
    if (requests.length > maxRecorded) requests.splice(0, requests.length - maxRecorded);
  }

  /** Gives upstream's SSE a unique completion id and this mock's model name. */
  async function finish(response: Response, streamed: boolean): Promise<Response> {
    const id = `chatcmpl-mock-${++completionSeq}`;
    const parts = chunks(await response.text()).map(chunk => ({ ...chunk, id, model: MODEL_ID }));
    if (!streamed) return Response.json(collect(parts));
    const sse = parts.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }

  async function complete(path: string, headers: Headers, text: string): Promise<Response> {
    const body = parseJson(text);
    const streamed = (body as { stream?: unknown } | null)?.stream === true;
    const url = new URL(path, `http://${HOST}`);
    const request = () => new Request(url, { method: "POST", headers, body: text });
    // With no steps, upstream answers a quick-model prompt from its table and throws on anything
    // else, after recording it as an agent request.
    const probe = scriptedChatCompletions([]);
    let auxiliary: Response | null = null;
    try {
      auxiliary = await probe.handler(url, "POST", headers, request());
    } catch (error) {
      if (probe.requests.length !== 1) throw error;
    }
    const kind = probe.auxiliaryRequests[0]?.kind;
    if (auxiliary !== null && kind !== undefined) {
      record({ method: "POST", path, kind, body });
      return finish(auxiliary, streamed);
    }
    // An agent request: take its step with no await between the decision and the shift, so
    // concurrent requests never share a step.
    const step = queue.shift() ?? DEFAULT_STEP;
    record({ method: "POST", path, kind: "agent", body });
    if ("error" in step) return errorResponse(step.error.status, step.error.message);
    const response = await scriptedChatCompletions([step]).handler(url, "POST", headers, request());
    if (response === null) throw new Error(`upstream's handler declined ${path}`);
    return finish(response, streamed);
  }

  async function handle(req: IncomingMessage): Promise<Response> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
    const route = `${method} ${path}`;
    if (route === "GET /api/tags") {
      record({ method, path, kind: "models", body: null });
      return Response.json({
        models: [{
          name: MODEL_ID, model: MODEL_ID, modified_at: "1970-01-01T00:00:00Z", size: 0, digest: "",
          details: { format: "", family: MODEL_ID, families: [MODEL_ID], parameter_size: "", quantization_level: "" },
        }],
      });
    }
    if (route === "GET /v1/models") {
      record({ method, path, kind: "models", body: null });
      return Response.json({
        object: "list",
        data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "celld-e2e" }],
      });
    }
    if (route === "POST /v1/chat/completions") {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      return complete(path, headers, await readBody(req));
    }
    if (route === "POST /__script") {
      const raw = parseJson(await readBody(req));
      const steps = (Array.isArray(raw) ? raw : [raw]).map(parseStep);
      queue.push(...steps);
      return Response.json({ queued: queue.length });
    }
    if (route === "GET /__requests") return Response.json(requests);
    if (route === "POST /__reset") {
      queue = [];
      requests = [];
      return Response.json({ queued: 0 });
    }
    record({ method, path, kind: "unmatched", body: null });
    return errorResponse(404, `mock-llm has no route ${route}`);
  }

  const server = createServer((req, res) => {
    handle(req)
      .catch((error: unknown) => {
        if (error instanceof RequestError) return errorResponse(error.status, error.message);
        console.error(`mock-llm: ${req.method} ${req.url}:`, error);
        return errorResponse(500, String(error));
      })
      .then(response => send(res, response))
      .catch((error: unknown) => {
        console.error(`mock-llm: ${req.method} ${req.url}: could not answer:`, error);
        res.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve());
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    server,
    origin: `http://${HOST}:${bound}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}

async function selfTest(): Promise<void> {
  const mock = await startMockLlm({ port: 0 });
  const small = await startMockLlm({ port: 0, maxRecorded: 2 });
  const client = (origin: string) => {
    const at = (path: string, init?: RequestInit) => fetch(origin + path, init);
    const post = (path: string, body: unknown) => at(path,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const chat = (stream: boolean, content = "hello") =>
      post("/v1/chat/completions", { model: MODEL_ID, stream, messages: [{ role: "user", content }] });
    return { at, post, chat };
  };
  const { at, post, chat } = client(mock.origin);
  const TITLE_PROMPT = "Generate a brief, descriptive title for this chat";
  const expectError = async (response: Response, status: number, type: string, message?: string) => {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), "application/json");
    const { error } = await response.json();
    assert.equal(error.type, type);
    if (message !== undefined) assert.equal(error.message, message);
  };
  const check = async (name: string, run: () => Promise<void>) => {
    await run();
    console.log(`PASS ${name}`);
  };
  try {
    await check("GET /api/tags", async () => {
      const body = await (await at("/api/tags")).json();
      assert.deepEqual(body.models.map((m: { name: string }) => m.name), [MODEL_ID]);
    });
    await check("GET /v1/models", async () => {
      const body = await (await at("/v1/models")).json();
      assert.deepEqual(body.data.map((m: { id: string }) => m.id), [MODEL_ID]);
    });
    await check("default reply, non-streamed", async () => {
      const response = await chat(false);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.object, "chat.completion");
      assert.equal(body.model, MODEL_ID);
      assert.deepEqual(body.choices[0].message, { role: "assistant", content: "ok" });
      assert.equal(body.choices[0].finish_reason, "stop");
    });
    await check("POST /__script rejects bad steps and bodies", async () => {
      await expectError(await post("/__script", [{ text: 1 }]), 400, "invalid_request_error", "text must be a string");
      await expectError(await post("/__script", { nope: true }), 400, "invalid_request_error");
      await expectError(await at("/__script", { method: "POST", body: "{" }), 400, "invalid_request_error");
    });
    await check("POST /__script queues steps", async () => {
      const response = await post("/__script", [
        { text: "scripted text" },
        { toolCall: { id: "call-1", name: "run", arguments: { code: "1 + 1" } } },
        { error: { status: 503, message: "overloaded" } },
        { error: "broken" },
      ]);
      assert.deepEqual(await response.json(), { queued: 4 });
    });
    await check("text step, streamed", async () => {
      const response = await chat(true);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const sse = await response.text();
      const parts = chunks(sse);
      assert.ok(sse.includes('"content":"scripted text"'), sse);
      assert.ok(sse.trimEnd().endsWith("data: [DONE]"), sse);
      assert.ok(parts.every(chunk => chunk.model === MODEL_ID && chunk.id === parts[0].id), sse);
    });
    await check("quick-model prompt leaves the queue alone", async () => {
      const response = await chat(false, TITLE_PROMPT);
      assert.equal((await response.json()).choices[0].message.content, "Test chat");
    });
    await check("tool-call step, streamed", async () => {
      const sse = await (await chat(true)).text();
      assert.ok(sse.includes('"name":"run"') && sse.includes('"finish_reason":"tool_calls"'), sse);
    });
    await check("error steps", async () => {
      await expectError(await chat(false), 503, "server_error", "overloaded");
      await expectError(await chat(true), 500, "server_error", "broken");
    });
    await check("queue empty: default reply, streamed", async () => {
      assert.ok((await (await chat(true)).text()).includes('"content":"ok"'));
    });
    await check("tool call, non-streamed", async () => {
      await post("/__script", { toolCall: { id: "call-2", name: "save", arguments: { a: [1] } } });
      const body = await (await chat(false)).json();
      assert.deepEqual(body.choices[0].message.tool_calls,
          [{ id: "call-2", type: "function", function: { name: "save", arguments: '{"a":[1]}' } }]);
      assert.equal(body.choices[0].finish_reason, "tool_calls");
    });
    await check("GET /__requests", async () => {
      const recorded = await (await at("/__requests")).json() as RecordedRequest[];
      assert.deepEqual(recorded.map(r => r.kind),
          ["models", "models", "agent", "agent", "thread-title", "agent", "agent", "agent", "agent", "agent"]);
      assert.deepEqual((recorded[2].body as { messages: unknown[] }).messages, [{ role: "user", content: "hello" }]);
    });
    await check("concurrent requests take each step once, with unique ids", async () => {
      await post("/__script", [{ text: "one" }, { text: "two" }, { text: "three" }]);
      const bodies = await Promise.all([chat(false), chat(false, TITLE_PROMPT), chat(false), chat(false)]
          .map(async response => (await response).json()));
      const texts = bodies.map(body => body.choices[0].message.content);
      assert.equal(texts[1], "Test chat");
      assert.deepEqual([texts[0], texts[2], texts[3]].sort(), ["one", "three", "two"]);
      assert.equal(new Set(bodies.map(body => body.id)).size, bodies.length);
    });
    await check("POST /__reset", async () => {
      await post("/__script", { text: "dropped" });
      assert.deepEqual(await (await post("/__reset", {})).json(), { queued: 0 });
      assert.deepEqual(await (await at("/__requests")).json(), []);
      assert.equal((await (await chat(false)).json()).choices[0].message.content, "ok");
    });
    await check("unknown route", async () => {
      await expectError(await at("/v1/embeddings", { method: "POST" }), 404, "not_found_error");
    });
    await check("GET /__requests keeps only the newest", async () => {
      const capped = client(small.origin);
      await capped.at("/api/tags");
      await capped.chat(false, "first");
      await capped.chat(false, "second");
      const recorded = await (await capped.at("/__requests")).json() as RecordedRequest[];
      assert.deepEqual(recorded.map(r => (r.body as { messages: { content: string }[] }).messages[0].content),
          ["first", "second"]);
    });
  } finally {
    await Promise.all([mock.close(), small.close()]);
  }
  console.log("mock-llm self-test passed");
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    await selfTest();
  } else {
    const mock = await startMockLlm();
    console.error(`mock-llm listening on ${mock.origin} (model ${MODEL_ID})`);
    const stop = () => mock.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
}
