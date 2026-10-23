// Takes the place of upstream's `src/harness.ts` when CFOS_RUNTIME=celld (see vitest.config.ts), so
// upstream's integration tests drive the Workers on celld (celld plan item 0.5).
//
// `startCelldHarness()` returns upstream's `Harness`. It builds the Worker configs as upstream's
// `startHarness()` does (the same `workshopConfig` steps and the suite's patches), passes each
// through generate.ts's `celldFilter`, and runs them all under one multi-config `celld dev`:
//
// - The primary Worker is a generated `test-front`. It service-binds every Worker, forwards
//   `/__worker/<name>/…` to that Worker (for `fetchWorker`), and passes everything else, the `/api`
//   WebSocket included, to the Workshop, which is upstream's primary.
// - Every other Worker's main module is wrapped so `integration/upstream-shim.js` runs first and
//   sends its global fetch() to `celld/mock-upstream.ts`, where the suite's NetworkInterceptor
//   answers (see network-interceptor.ts). CELLD_FETCH_PRIVATE_ALLOW names that server exactly.
// - `celld dev` runs with `--port 0`, `--no-watch` and `--no-build` (the validated trees are
//   prebuilt, as upstream's global setup requires), in its own directory under
//   `.celld/integration/`, which holds the generated configs, the node's state and `dev.log`.
// - `redeployWorkshop()` stops `celld dev` and starts it again on the same port and state with the
//   new Workshop config, which is what a redeploy is to celld dev: every Worker restarts and storage
//   is kept.
//
// Everything else upstream's harness module exports is re-exported unchanged.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { expect } from "vitest";
import { celldFilter } from "../generate.ts";
import type {
  GatekeeperSpec, Harness, WorkerConfig,
} from "../../cloudflare-os/packages/integration-tests/src/harness.ts";
import {
  ADMIN_USERNAME, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR,
} from "../../cloudflare-os/packages/integration-tests/src/harness.ts";
import { acquireMockUpstream, releaseMockUpstream } from "./network-interceptor.ts";

export {
  ADMIN_USERNAME, bundleBlueprints, hookServer, RESTART_SETTLE_MS, settleRestart,
  TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID,
  testActionState, testControl,
  type BundledBlueprintSpec, type GatekeeperSpec, type Harness, type WorkerConfig,
} from "../../cloudflare-os/packages/integration-tests/src/harness.ts";

type TestHarness = Harness["server"];

const STARTER = resolve(import.meta.dirname, "../..");
const WORKSHOP_DIR = join(STARTER, "cloudflare-os/packages/workshop-backend");
const SHIM = join(import.meta.dirname, "upstream-shim.js");
const FRONT = "test-front";
const WORKSHOP = "workshop-backend";
/** The header that carries the origin a `fetchWorker` caller asked for, to `test-front`. */
const ORIGIN_HEADER = "x-celld-harness-origin";
/** Under upstream's 120 s hook timeout, so a slow start fails with its own message. */
const READY_TIMEOUT_MS = 110_000;
/** celld bounds its own shutdown at CELLD_SHUTDOWN_TOTAL_MS (40 s). */
const STOP_TIMEOUT_MS = 45_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; run the suites through celld/integration.sh, ` +
        "which sources celld/env.sh");
  }
  return value;
}

// As upstream's readWorkerConfig: `build.cwd` pinned to the package, and `main` made absolute.
function readWorkerConfig(dir: string): WorkerConfig {
  const path = join(dir, "wrangler.jsonc");
  const errors: ParseError[] = [];
  const config = parse(readFileSync(path, "utf8"), errors) as WorkerConfig;
  if (errors.length > 0) {
    throw new Error(`${path} is not valid JSONC: ${errors.map(e => printParseErrorCode(e.error)).join(", ")}`);
  }
  if (typeof config?.name !== "string" || typeof config.main !== "string") {
    throw new Error(`${path} is not a usable worker config: it needs a string name and main`);
  }
  config.build = { ...config.build, cwd: dir };
  config.main = join(dir, config.main);
  return config;
}

// Upstream's workshopConfig, step for step.
function workshopConfig(
    gatekeepers: { binding: string; name: string }[],
    enableGadgetExecution: boolean,
    patch?: (config: WorkerConfig) => void): WorkerConfig {
  const config = readWorkerConfig(WORKSHOP_DIR);
  if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
  config.services = gatekeepers.map(gk => ({
    binding: `GATEKEEPER_${gk.binding}`,
    service: gk.name,
    entrypoint: "GatekeeperVendor",
  }));
  config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME], PUBLIC_BASE_URL: "http://workshop.test" };
  if (!enableGadgetExecution) delete config.worker_loaders;
  patch?.(config);
  return config;
}

/**
 * The adapter's own workaround, on top of `celldFilter`: celld refuses a Durable Object binding to
 * another script's class (`script_name`). Only upstream's fixture gatekeeper declares one
 * (`WORKSHOP_OVERSEER`, which only the external-message suites use), so it is dropped, with a note
 * on stderr, and those suites stay out of status.json.
 */
function dropForeignDurableObjectBindings(config: WorkerConfig): string[] {
  const bindings = (config.durable_objects as { bindings?: { name: string; script_name?: string }[] }
      | undefined)?.bindings;
  if (!bindings) return [];
  const foreign = bindings.filter(binding => binding.script_name !== undefined);
  if (foreign.length === 0) return [];
  const kept = bindings.filter(binding => binding.script_name === undefined);
  if (kept.length > 0) {
    (config.durable_objects as { bindings: unknown[] }).bindings = kept;
  } else {
    delete config.durable_objects;
  }
  return foreign.map(binding => `durable_objects ${binding.name} (script_name ${binding.script_name})`);
}

/**
 * Another workaround: upstream's fixture gatekeeper sets the `experimental` compatibility flag,
 * which celld refuses at deploy, as Cloudflare does (celld plan item 1.16). The fixture uses none of
 * the APIs the flag gates, so the flag is dropped, with a note on stderr.
 */
function dropExperimentalFlag(config: WorkerConfig): string[] {
  const flags = config.compatibility_flags as string[] | undefined;
  if (!flags?.includes("experimental")) return [];
  config.compatibility_flags = flags.filter(flag => flag !== "experimental");
  return ["compatibility flag experimental"];
}

/** Every Worker's config, ready for celld: filtered, without a build, its main wrapped. */
function celldConfigs(dir: string, configs: WorkerConfig[]): Record<string, WorkerConfig> {
  const out: Record<string, WorkerConfig> = {};
  for (const input of configs) {
    const filtered = celldFilter(input);
    // celldFilter only removes keys, so the result is still a WorkerConfig.
    const config = filtered.config as WorkerConfig;
    const dropped = filtered.dropped;
    dropped.push(...dropForeignDurableObjectBindings(config));
    dropped.push(...dropExperimentalFlag(config));
    if (dropped.length > 0) {
      console.error(`celld harness: ${config.name}: dropped ${dropped.join(", ")}`);
    }
    // The validated trees are prebuilt (upstream's global setup checks them), and celld dev runs
    // with --no-build, so a build command would only mislead.
    delete config.build;
    // celld resolves `main` inside the config's directory, so it is relative.
    const entry = `${config.name}.entry.mjs`;
    writeFileSync(join(dir, entry), [
      `import "./upstream-shim-install.mjs";`,
      `export * from ${JSON.stringify(config.main)};`,
      `export { default } from ${JSON.stringify(config.main)};`,
      "",
    ].join("\n"));
    config.main = entry;
    out[config.name] = config;
  }
  return out;
}

const FRONT_SOURCE = `// Generated by celld/integration/harness.ts: the primary Worker of an integration-test harness.
const PREFIX = "/__worker/";
const ORIGIN_HEADER = ${JSON.stringify(ORIGIN_HEADER)};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return env[env.HARNESS_PRIMARY].fetch(request);
    const rest = url.pathname.slice(PREFIX.length);
    const slash = rest.indexOf("/");
    const name = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    const binding = Object.hasOwn(env.HARNESS_WORKERS, name) ? env.HARNESS_WORKERS[name] : undefined;
    if (binding === undefined) return new Response("test-front: no Worker named " + name, { status: 404 });
    const target = new URL((slash < 0 ? "/" : rest.slice(slash)) + url.search,
        request.headers.get(ORIGIN_HEADER) ?? url.origin);
    const headers = new Headers(request.headers);
    headers.delete(ORIGIN_HEADER);
    return env[binding].fetch(new Request(target, {
      method: request.method, headers, body: request.body, redirect: "manual",
    }));
  },
};
`;

function frontConfig(workers: Record<string, WorkerConfig>, primary: string): WorkerConfig {
  const names = Object.keys(workers);
  if (names.includes(FRONT)) throw new Error(`A Worker under test may not be named ${FRONT}`);
  const bindings = Object.fromEntries(names.map((name, index) => [name, `WORKER_${index}`]));
  return {
    name: FRONT,
    main: "test-front.mjs",
    compatibility_date: workers[primary].compatibility_date as string,
    services: names.map(name => ({ binding: bindings[name], service: name })),
    vars: { HARNESS_WORKERS: bindings, HARNESS_PRIMARY: bindings[primary] },
  };
}

type Running = { child: ChildProcess; public: URL; exited: Promise<void> };

/** One `celld dev` session over a harness directory. */
class CelldDev {
  readonly #dir: string;
  readonly #configs: string[];
  readonly #upstreamHostPort: string;
  #running: Running | undefined;
  #port = 0;

  constructor(dir: string, configs: string[], upstreamHostPort: string) {
    this.#dir = dir;
    this.#configs = configs;
    this.#upstreamHostPort = upstreamHostPort;
  }

  get logPath(): string {
    return join(this.#dir, "dev.log");
  }

  /** Starts celld dev and waits for its ready line. `clean` starts from empty state. */
  async start(clean: boolean): Promise<URL> {
    if (this.#running) throw new Error("celld dev is already running");
    const args = ["dev", ...this.#configs.flatMap(config => ["-c", config]),
      "--port", String(this.#port), "--no-watch", "--no-build", "--logs"];
    if (clean) args.push("--clean");
    const log = createWriteStream(this.logPath, { flags: "a" });
    log.write(`# ${new Date().toISOString()} celld ${args.join(" ")}\n`);
    const child = spawn(requireEnv("CELLD"), args, {
      cwd: this.#dir,
      // Its own process group, so a test process that dies can take the node down with it.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Exactly the mock upstream (plan item 1.9). The suites reach nothing else.
        CELLD_FETCH_PRIVATE_ALLOW: this.#upstreamHostPort,
      },
    });
    child.stderr!.pipe(log);
    // A spawn that fails emits "error" and never "exit".
    const exited = new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    registerChild(child);
    exited.then(() => unregisterChild(child));

    const ready = new Promise<URL>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", line => {
        log.write(`# stdout: ${line}\n`);
        let event: { event?: string; public?: string };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.event === "ready" && typeof event.public === "string") resolve(new URL(event.public));
      });
      child.once("exit", (code, signal) => reject(new Error(
          `celld dev exited (${signal ?? `code ${code}`}) before it was ready; see ${this.logPath}:\n` +
          tail(this.logPath))));
      child.once("error", reject);
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(
          `celld dev was not ready within ${READY_TIMEOUT_MS / 1000} s; see ${this.logPath}:\n` +
          tail(this.logPath))), READY_TIMEOUT_MS);
    });
    try {
      const url = await Promise.race([ready, timeout]);
      // A restart keeps the port, so `url` stays valid, as upstream's redeploy keeps it.
      this.#port = Number(url.port);
      this.#running = { child, public: url, exited };
      return url;
    } catch (error) {
      killGroup(child, "SIGKILL");
      await exited;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops celld dev, gracefully first. */
  async stop(): Promise<void> {
    const running = this.#running;
    if (!running) return;
    this.#running = undefined;
    killGroup(running.child, "SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      running.exited.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (!stopped) {
      console.error(`celld harness: celld dev did not stop within ${STOP_TIMEOUT_MS / 1000} s; killing it`);
      killGroup(running.child, "SIGKILL");
      await running.exited;
    }
  }
}

function tail(path: string, lines = 60): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

// A test process that exits without closing its harness, or is interrupted, must not leave a node
// behind. Each celld dev is its own process group (so a Ctrl-C at the terminal does not reach it),
// and these hooks take every group down. A test process killed with SIGKILL runs none of them;
// run.ts then sweeps what is left under its state directory.
const children = new Set<ChildProcess>();
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
let hooked = false;

function killAll(): void {
  for (const each of children) killGroup(each, "SIGKILL");
}

function onSignal(signal: NodeJS.Signals): void {
  killAll();
  // When nothing else handles the signal, die of it, as the process would have without this hook.
  if (process.listenerCount(signal) === 1) {
    for (const each of SIGNALS) process.removeListener(each, onSignal);
    process.kill(process.pid, signal);
  }
}

function registerChild(child: ChildProcess): void {
  children.add(child);
  if (hooked) return;
  hooked = true;
  process.once("exit", killAll);
  for (const signal of SIGNALS) process.on(signal, onSignal);
}
function unregisterChild(child: ChildProcess): void {
  children.delete(child);
}

/** A directory for one harness, named after the test file that starts it. */
function harnessDir(): string {
  const base = process.env.CELLD_INTEGRATION_STATE ?? join(STARTER, ".celld/integration");
  mkdirSync(base, { recursive: true });
  const testPath = expect.getState().testPath;
  const name = testPath ? basename(testPath).replace(/\.test\.ts$/, "") : "harness";
  return mkdtempSync(join(base, `${name}-`));
}

function unsupported(name: string): never {
  throw new Error(`The celld integration adapter does not support TestHarness.${name}()`);
}

/** Upstream's `startHarness()`, on celld. */
export async function startCelldHarness(opts: {
  gatekeepers: GatekeeperSpec[];
  patchWorkshop?: (config: WorkerConfig) => void;
  enableGadgetExecution?: boolean;
}): Promise<Harness> {
  const gatekeepers = opts.gatekeepers.map(gk => {
    const config = readWorkerConfig(gk.dir);
    gk.patch?.(config);
    return { binding: gk.binding, name: config.name, config };
  });

  const upstream = await acquireMockUpstream();
  let dev: CelldDev | undefined;
  try {
    const dir = harnessDir();
    writeFileSync(join(dir, "upstream-shim-install.mjs"), [
      `import { installUpstreamShim } from ${JSON.stringify(SHIM)};`,
      `installUpstreamShim(${JSON.stringify(upstream.origin)});`,
      "",
    ].join("\n"));
    writeFileSync(join(dir, "test-front.mjs"), FRONT_SOURCE);

    const write = (patchWorkshop?: (config: WorkerConfig) => void): string[] => {
      const workers = celldConfigs(dir, [
        workshopConfig(gatekeepers, opts.enableGadgetExecution ?? false, patchWorkshop),
        ...gatekeepers.map(({ config }) => structuredClone(config)),
      ]);
      const all = [frontConfig(workers, WORKSHOP), ...Object.values(workers)];
      return all.map(config => {
        const file = `${config.name}.jsonc`;
        writeFileSync(join(dir, file), JSON.stringify(config, null, 2) + "\n");
        return file;
      });
    };

    dev = new CelldDev(dir, write(opts.patchWorkshop), upstream.hostPort);
    const url = await dev.start(true);
    const names = new Set([WORKSHOP, ...gatekeepers.map(gk => gk.name)]);

    const fetchWorker: Harness["fetchWorker"] = async (name, input, init) => {
      if (!names.has(name)) throw new Error(`No Worker named ${name} in this harness`);
      // A relative URL resolves against the harness, as createTestHarness's does.
      const request = input instanceof Request
        ? new Request(input, init as RequestInit)
        : new Request(new URL(String(input), url), init as RequestInit);
      const target = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set(ORIGIN_HEADER, target.origin);
      const routed = new URL(`/__worker/${encodeURIComponent(name)}${target.pathname}${target.search}`, url);
      // Node's Response; Harness types it with the Workers' globals, which this package also sees.
      return fetch(new Request(routed, { ...requestInit(request), headers })) as unknown as
          ReturnType<Harness["fetchWorker"]>;
    };

    const workerHandle = (name: string) => ({
      fetch: ((input: never, init?: never) => fetchWorker(name, input, init)) as TestHarness["fetch"],
      email: () => unsupported("getWorker().email"),
      scheduled: () => unsupported("getWorker().scheduled"),
      getEnv: () => unsupported("getWorker().getEnv"),
      listDurableObjectIds: () => unsupported("getWorker().listDurableObjectIds"),
      evictDurableObject: () => unsupported("getWorker().evictDurableObject"),
      applyD1Migrations: () => unsupported("getWorker().applyD1Migrations"),
      getDurableObjectStorage: () => unsupported("getWorker().getDurableObjectStorage"),
      introspectWorkflowInstance: () => unsupported("getWorker().introspectWorkflowInstance"),
      introspectWorkflow: () => unsupported("getWorker().introspectWorkflow"),
      getExport: () => unsupported("getWorker().getExport"),
    });

    let closed: Promise<void> | undefined;
    const running = dev;
    const server = {
      listen: async () => ({ url }),
      // Unrouted requests reach the primary, which upstream makes the Workshop.
      fetch: ((input: never, init?: never) => fetchWorker(WORKSHOP, input, init)) as TestHarness["fetch"],
      getWorker: ((name?: string) => workerHandle(name ?? WORKSHOP)) as unknown as TestHarness["getWorker"],
      getLogs: () => unsupported("getLogs"),
      clearLogs: () => unsupported("clearLogs"),
      debug: () => console.error(`celld harness: the last lines of ${running.logPath}:\n${tail(running.logPath, 200)}`),
      update: () => unsupported("update"),
      reset: () => unsupported("reset"),
      close: () => closed ??= running.stop().finally(() => releaseMockUpstream()),
    } satisfies TestHarness;

    return {
      server,
      url,
      fetchWorker,
      redeployWorkshop: async patchWorkshop => {
        if (closed) throw new Error("The harness is closed");
        await running.stop();
        write(patchWorkshop);
        await running.start(false);
      },
    };
  } catch (error) {
    await dev?.stop();
    await releaseMockUpstream();
    throw error;
  }
}

/** The parts of a Request that a new Request to another URL keeps. */
function requestInit(request: Request): RequestInit {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return {
    method: request.method,
    body: hasBody ? request.body : undefined,
    redirect: request.redirect,
    signal: request.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit;
}

/** Upstream's `startHarness()`, on celld: the name the suites import. */
export const startHarness = startCelldHarness;

/** Upstream's `startTestGatekeeperHarness()`, on celld. */
export function startTestGatekeeperHarness(options: { enableGadgetExecution?: boolean } = {})
    : Promise<Harness> {
  return startCelldHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    enableGadgetExecution: options.enableGadgetExecution,
  });
}
