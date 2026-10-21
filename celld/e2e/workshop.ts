// What smoke.ts and browser.ts share: the app's own capnweb, the frontend's password hash, the
// trial account, the mock LLM's control API, and a runner for steps that pass, fail or skip.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AiChatAuthorInfo, AiModelConfig, AuthenticatedApi, PublicApi,
} from "../../cloudflare-os/packages/workshop-shared/src/api.ts";
import type { RpcStub } from "capnweb";

export const root = join(import.meta.dirname, "../..");
const sharedDir = join(root, "cloudflare-os/packages/workshop-shared");

// The capnweb the app itself speaks, and the frontend's hash-wasm, from the submodule's install.
// Every stub must be minted by this one capnweb instance, or the session cannot serialize it.
export const capnweb = createRequire(join(sharedDir, "package.json"))("capnweb") as typeof import("capnweb");
const { argon2id } = createRequire(join(root, "cloudflare-os/packages/workshop-frontend/package.json"))(
    "hash-wasm") as { argon2id(options: Record<string, unknown>): Promise<Uint8Array> };

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (source celld/env.sh, or run through celld/e2e.sh)`);
  return value;
}

/** The trial admin account (celld/env.sh); generate.ts makes `admin` the deployment's admin. */
export const USERNAME = requireEnv("CFOS_TRIAL_USER");
const PASSWORD = requireEnv("CFOS_TRIAL_PASSWORD");
export const STATE = join(root, process.env.E2E_STATE || ".celld/e2e");
export const MOCK_LLM = `http://127.0.0.1:${process.env.MOCK_LLM_PORT || "11434"}`;

/** The model the tests chat with: the mock LLM, as an "Other Ollama…" provider. */
export const MODEL_PROFILE: AiChatAuthorInfo = { type: "agent", id: "scripted", name: "Scripted (e2e mock)" };
const MODEL_CONFIG: AiModelConfig = { provider: "ollama", model: "scripted", apiUrl: MOCK_LLM, apiToken: "" };

// --- small helpers ------------------------------------------------------------------------------

/**
 * The running step's signal, aborted when the step times out. sleep() and waitFor() honour it, so
 * a timed-out step stops at its next wait instead of running on beside the steps after it.
 */
let stepSignal: AbortSignal | undefined;

export function sleep(ms: number, signal = stepSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Polls `attempt` until it returns non-null, or throws at the deadline or when the step is aborted. */
export async function waitFor<T>(what: string, attempt: () => Promise<T | null>, timeoutMs: number,
    signal = stepSignal): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const result = await attempt();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(250, signal);
  }
}

// --- the account --------------------------------------------------------------------------------

/** The salt prefix of the frontend's password hash, read from the shared API source. */
function serviceSalt(): Uint8Array {
  const source = readFileSync(join(sharedDir, "src/api.ts"), "utf8");
  const match = /export const SERVICE_SALT = new Uint8Array\(\[([^\]]*)\]\);/.exec(source);
  if (!match) throw new Error("SERVICE_SALT not found in workshop-shared/src/api.ts");
  const bytes = match[1].split(",").map(part => part.trim()).filter(Boolean).map(Number);
  if (bytes.length !== 16 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`SERVICE_SALT in workshop-shared/src/api.ts is not 16 bytes: ${match[1]}`);
  }
  return new Uint8Array(bytes);
}

/** The frontend's password hash (cos:workshop-frontend/src/passwordHash.ts). */
async function hashPassword(username: string, password: string): Promise<Uint8Array> {
  const prefix = serviceSalt();
  const name = new TextEncoder().encode(username);
  const salt = new Uint8Array(prefix.length + name.length);
  salt.set(prefix);
  salt.set(name, prefix.length);
  return argon2id({
    password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: "binary",
  });
}

let token: string | undefined;

/** Creates the trial account if it does not exist, or logs in; then authenticates. */
export async function signIn(api: RpcStub<PublicApi>): Promise<RpcStub<AuthenticatedApi>> {
  if (token === undefined) {
    const hash = await hashPassword(USERNAME, PASSWORD);
    token = await api.createAccount(USERNAME, USERNAME, hash) ?? undefined;
    if (token === undefined) {
      token = await api.login(USERNAME, hash) ?? undefined;
      if (token === undefined) {
        throw new Error(`createAccount("${USERNAME}") found the account, but login() refused the password from celld/env.sh`);
      }
    }
  }
  return api.authenticate(token) as unknown as RpcStub<AuthenticatedApi>;
}

/** Adds the mock LLM as the user's `scripted` model, unless it is there. */
export async function ensureModel(api: RpcStub<AuthenticatedApi>): Promise<void> {
  const models = await api.listModels();
  if (!models.some(model => model.id === MODEL_PROFILE.id)) await api.addModel(MODEL_PROFILE, MODEL_CONFIG);
}

// --- the mock LLM's control API (celld/mock-llm.ts) ---------------------------------------------

export type RecordedMessage = { role: string; content?: unknown; tool_call_id?: string };
type Recorded = { kind: string; body: { messages?: RecordedMessage[] } };

/** GET, or POST `body` as JSON, to the mock's control API. */
export async function mock(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(MOCK_LLM + path, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`mock LLM ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** The agent requests the mock received since its last reset, oldest first. */
export async function agentRequests(): Promise<Recorded[]> {
  return ((await mock("/__requests")) as Recorded[]).filter(request => request.kind === "agent");
}

export function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

// --- steps --------------------------------------------------------------------------------------

export type Status = "PASS" | "FAIL" | "SKIP";

export type Step = {
  id: string;
  title: string;
  /** The trial failure or plan item a FAIL points at. */
  covers: string;
  /**
   * Steps whose action must have succeeded first, or this one is skipped. A step whose action
   * succeeded but that `after` failed (browser.ts: a console error on the way) still counts.
   */
  needs: string[];
  timeoutMs: number;
  /**
   * Returns a short note on success; throws to fail; `skip()` skips. `signal` aborts when the step
   * times out; a body that waits other than through sleep() or waitFor() must honour it itself.
   */
  run: (signal: AbortSignal) => Promise<string | void>;
};

class Skip extends Error {}

export function skip(reason: string): never {
  throw new Skip(reason);
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Playwright appends a coloured call log; the first part says what failed.
  const message = error.message.split(/\n(?:Call log:|=+ logs =+)/)[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
  return `${error.name}: ${message}`;
}

export type Results = Map<string, { status: Status; detail: string; completed: boolean }>;

/**
 * Runs `steps` in order, recording each result in `results` and printing it as it lands, so a step
 * can read the steps before it. `after` runs after every step that ran, whatever its outcome
 * (browser.ts takes its screenshot there), and turns a PASS into a FAIL by returning a reason.
 */
export async function runSteps(steps: Step[], results: Results,
    after?: (step: Step, status: Status) => Promise<string | void>): Promise<void> {
  for (const step of steps) {
    const unmet = step.needs.filter(id => !results.get(id)?.completed);
    let status: Status;
    let detail: string;
    let completed = false;
    if (unmet.length) {
      status = "SKIP";
      detail = `needs ${unmet.map(id => `${id} (${results.get(id)?.status ?? "not run"})`).join(", ")}`;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() =>
        controller.abort(new Error(`${step.id}: timed out after ${step.timeoutMs / 1000} s`)), step.timeoutMs);
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason)));
      aborted.catch(() => {});
      stepSignal = controller.signal;
      try {
        detail = (await Promise.race([step.run(controller.signal), aborted])) ?? "";
        status = "PASS";
        completed = true;
      } catch (error) {
        status = error instanceof Skip ? "SKIP" : "FAIL";
        detail = error instanceof Skip ? error.message : describeError(error);
      } finally {
        clearTimeout(timer);
        // Anything the body still has in flight stops at its next wait.
        controller.abort(new Error(`${step.id} has ended`));
        stepSignal = undefined;
      }
      const objection = await after?.(step, status).catch(error => `after the step: ${describeError(error)}`);
      if (objection) {
        if (status === "PASS") status = "FAIL";
        detail = [detail, objection].filter(Boolean).join("\n    ");
      }
    }
    results.set(step.id, { status, detail, completed });
    const covers = step.covers ? ` [covers: ${step.covers}]` : "";
    console.log(`${status} ${step.id} ${step.title}${covers}${detail ? `\n    ${detail}` : ""}`);
  }
}

/** Prints the results in `order` and returns how many failed. */
export function summarize(name: string, results: Results, order: string[]): number {
  console.log(`\n${name} summary:`);
  for (const id of order) console.log(`  ${id.padEnd(4)} ${results.get(id)?.status ?? "not run"}`);
  const failed = order.filter(id => results.get(id)?.status === "FAIL");
  console.log(failed.length ? `${name}: ${failed.length} step(s) failed: ${failed.join(", ")}` : `${name}: no step failed`);
  return failed.length;
}

// --- node.log -----------------------------------------------------------------------------------

/**
 * The part of the node's log written since start(). A node restart (`e2e.sh restart`, which runs
 * `node`) moves node.log to node.log.prev, so a restart is bracketed by beforeRestart() and
 * afterRestart(), which picks up what the old node wrote up to its exit from node.log.prev.
 */
export class NodeLog {
  readonly #path: string;
  #offset = 0;
  #before = "";

  constructor(path = join(STATE, "node.log")) {
    this.#path = path;
  }

  start(): void {
    this.#offset = fileSize(this.#path);
  }

  beforeRestart(): void {
    // Nothing is read yet: the old node keeps logging until it exits.
  }

  afterRestart(): void {
    this.#before += readFrom(`${this.#path}.prev`, this.#offset);
    this.#offset = 0;
  }

  text(): string {
    return this.#before + readFrom(this.#path, this.#offset);
  }
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function readFrom(path: string, offset: number): string {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return ""; }
  try {
    const size = statSync(path).size;
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Messages in node.log that mean a known failure (smoke S11, browser B6). */
const FAILURE_PATTERNS = [
  "cannot cross isolate", "could not be cloned", "is not a function", "Invalid reader mode",
  "already disposed", "does not implement",
];
const DROPPED_FRAME = "dropped a frame for a closed WebSocket";

/**
 * The known failure messages in `log`, one finding per pattern. celld logs DROPPED_FRAME
 * (ws_registry.rs) on every clean client disconnect too, so it counts only when `closed1006` of
 * the run's own /api WebSockets closed with 1006. The line names a server-side `ws_id`, but no
 * info-level line maps a client's socket to its ws_id, so the count is for the whole run, not for
 * the abnormal socket alone.
 */
export function scanNodeLog(log: string, closed1006: number): string[] {
  const lines = log.split("\n");
  const patterns = closed1006 ? [...FAILURE_PATTERNS, DROPPED_FRAME] : FAILURE_PATTERNS;
  return patterns.flatMap(pattern => {
    const hits = lines.filter(line => line.includes(pattern));
    return hits.length ? [`${hits.length} x "${pattern}" in node.log, first: ${hits[0].trim().slice(0, 300)}`] : [];
  });
}
