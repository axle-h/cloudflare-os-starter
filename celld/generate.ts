// Generates celld deploy configs for a local trial of Cloudflare OS on celld.
//
// Mirrors `generateConfigs()` in packages/cf-os/src/core/deployment.ts for the default Workers. Each
// config is written to the project root as `celld.<worker>.jsonc`, because celld resolves `main` and
// `assets.directory` inside the config's own directory and the router's assets live in a sibling
// package. `build.cwd` and `build.watch_dir` are rebased onto the Worker's package, so `celld deploy`
// runs each Worker's `build.command` (its capnweb-validate step) where `wrangler deploy` would.
//
// The one workaround left: celld refuses the `ai` and `browser` bindings (decision D9), so they are
// dropped.
//
// Sign-in is upstream's built-in password accounts: no CF_ACCESS_* vars, and the frontend built
// without VITE_CF_ACCESS_MODE.
//
// Usage: node celld/generate.ts [--keep-unsupported] [--no-router]
//   --keep-unsupported  keep `ai` and `browser`, to see `celld deploy` refuse them.
//   --no-router         serve the frontend from the workshop and make it the primary Worker,
//                       instead of the router. It was workaround W5, for a WebSocket returned
//                       through a service binding (celld plan item 1.7 fixed it).
//
// Importing the module writes nothing: `celldFilter` applies the workarounds to one config, and
// `generateConfigs` builds every Worker's config.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

export type Config = Record<string, any>;

/** Each Worker's package directory, relative to the project root. */
const packages = {
  router: "cloudflare-os/packages/router",
  "workshop-backend": "cloudflare-os/packages/workshop-backend",
  "gatekeeper-context": "cloudflare-os/packages/gatekeeper-context",
  "gatekeeper-scheduler": "cloudflare-os/packages/gatekeeper-scheduler",
  "gatekeeper-websearch": "cloudflare-os/packages/gatekeeper-websearch",
  "custom-gatekeeper": "packages/custom-gatekeeper",
  "error-reporter": "packages/error-reporter",
} as const;
type Worker = keyof typeof packages;

/** Deploy order: every service-binding target before the Worker that binds it. */
export const deployOrder: Worker[] = [
  "error-reporter",
  "gatekeeper-context",
  "gatekeeper-scheduler",
  "gatekeeper-websearch",
  "custom-gatekeeper",
  "workshop-backend",
  "router",
];

/** The keys celld refuses that the Workers use: the AI and Browser Rendering bindings (D9). */
const REFUSED_KEYS = ["ai", "browser"];

/**
 * Applies the celld workarounds to one Wrangler config and returns a new config, with the keys it
 * dropped. The input is not changed.
 */
export function celldFilter(input: Config): { config: Config; dropped: string[] } {
  const config = structuredClone(input);
  const dropped = REFUSED_KEYS.filter((key) => key in config);
  for (const key of dropped) delete config[key];
  return { config, dropped };
}

function readJsonc(path: string): Config {
  const source = readFileSync(path, "utf8");
  // The base configs carry only whole-line comments.
  return JSON.parse(source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));
}

/** Rebase the package-relative paths of a base config onto the project root. */
function rebase(config: Config, dir: string): Config {
  const out = structuredClone(config);
  delete out.$schema;
  if (out.main) out.main = join(dir, out.main);
  if (out.assets?.directory) out.assets.directory = join(dir, out.assets.directory);
  if (out.build?.command) {
    // Wrangler's defaults, `.` and `src`, are relative to the package.
    out.build.cwd = join(dir, out.build.cwd ?? ".");
    const watch = out.build.watch_dir ?? "src";
    out.build.watch_dir = Array.isArray(watch) ? watch.map((path: string) => join(dir, path)) : join(dir, watch);
  }
  return out;
}

function base(worker: Worker): Config {
  return rebase(readJsonc(join(root, packages[worker], "wrangler.jsonc")), packages[worker]);
}

export type GenerateOptions = {
  /** Serve the frontend from the workshop and make it the primary Worker. */
  noRouter?: boolean;
  /** Keep the keys celld refuses, so `celld deploy` rejects them. */
  keepUnsupported?: boolean;
  publicBaseUrl?: string;
};

/** Every Worker's celld config, and the keys `celldFilter` dropped from each. */
export function generateConfigs(options: GenerateOptions = {}): {
  configs: Record<Worker, Config>;
  dropped: Partial<Record<Worker, string[]>>;
} {
  const { noRouter = false, keepUnsupported = false } = options;
  const publicBaseUrl = options.publicBaseUrl ?? "http://127.0.0.1:8790";
  const configs: Record<Worker, Config> = {} as Record<Worker, Config>;

  configs.router = base("router");
  configs.router.services = [
    { binding: "WORKSHOP_BACKEND", service: "workshop-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "gatekeeper-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "gatekeeper-scheduler" },
    { binding: "GATEKEEPER_WEBSEARCH", service: "gatekeeper-websearch" },
    { binding: "GATEKEEPER_CUSTOM", service: "custom-gatekeeper" },
  ];

  configs["workshop-backend"] = base("workshop-backend");
  Object.assign(configs["workshop-backend"], {
    // A JSON var, as on Cloudflare. Password-mode admins are usernames.
    vars: { ADMINS: ["admin"], PUBLIC_BASE_URL: publicBaseUrl },
    ai: { binding: "WORKERS_AI" },
    services: [
      {
        binding: "ERROR_REPORTER",
        service: "error-reporter",
        entrypoint: "ErrorReporter",
        props: { service: "workshop-backend", environment: "celld-trial" },
      },
      {
        binding: "GATEKEEPER_CONTEXT",
        service: "gatekeeper-context",
        entrypoint: "GatekeeperVendor",
        props: { sharingDomain: publicBaseUrl },
      },
      { binding: "GATEKEEPER_SCHEDULER", service: "gatekeeper-scheduler", entrypoint: "GatekeeperVendor" },
      { binding: "GATEKEEPER_WEBSEARCH", service: "gatekeeper-websearch", entrypoint: "GatekeeperVendor" },
      { binding: "GATEKEEPER_CUSTOM", service: "custom-gatekeeper", entrypoint: "GatekeeperVendor" },
    ],
    kv_namespaces: [
      { binding: "BLUEPRINTS", id: "blueprints" },
      { binding: "AVATARS", id: "avatars" },
    ],
    r2_buckets: [{ binding: "BLUEPRINT_CONTENT", bucket_name: "blueprint-content" }],
  });
  delete configs["workshop-backend"].assets;
  if (noRouter) {
    configs["workshop-backend"].assets = {
      ...configs.router.assets,
      run_worker_first: ["/api", "/api/*", "/blueprint-screenshot", "/blueprint-screenshot/*"],
    };
  }

  configs["gatekeeper-context"] = base("gatekeeper-context");
  configs["gatekeeper-context"].kv_namespaces = [
    { binding: "CONTEXT_COLLECTIONS", id: "context-collections" },
  ];

  configs["gatekeeper-scheduler"] = base("gatekeeper-scheduler");
  configs["gatekeeper-websearch"] = base("gatekeeper-websearch");

  configs["custom-gatekeeper"] = base("custom-gatekeeper");
  configs["custom-gatekeeper"].vars = {
    CUSTOM_NAME: "celld trial",
    CUSTOM_MESSAGE: "Cloudflare OS running on celld.",
  };

  configs["error-reporter"] = base("error-reporter");

  const dropped: Partial<Record<Worker, string[]>> = {};
  for (const worker of deployOrder) {
    if (keepUnsupported) continue;
    const filtered = celldFilter(configs[worker]);
    configs[worker] = filtered.config;
    if (filtered.dropped.length) dropped[worker] = filtered.dropped;
  }
  return { configs, dropped };
}

if (import.meta.main) {
  const { configs, dropped } = generateConfigs({
    noRouter: process.argv.includes("--no-router"),
    keepUnsupported: process.argv.includes("--keep-unsupported"),
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  });
  for (const worker of deployOrder) {
    writeFileSync(join(root, `celld.${worker}.jsonc`), JSON.stringify(configs[worker], null, 2) + "\n");
  }
  for (const [worker, keys] of Object.entries(dropped)) {
    console.error(`${worker}: dropped ${keys.join(", ")}`);
  }
}
