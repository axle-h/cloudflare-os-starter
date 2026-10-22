// Runs upstream's integration suites (cloudflare-os/packages/integration-tests) with this
// directory's adapter (celld plan item 0.5). celld/integration.sh is the entry point.
//
// CFOS_RUNTIME chooses the runtime:
// - `celld`: the suites' `../src/harness.js` and `../src/network-interceptor.js` resolve to
//   harness.ts and network-interceptor.ts here, so every Worker runs under `celld dev`.
// - `workerd`: upstream's own modules, under wrangler's createTestHarness, as the reference.
//
// The adapter's modules import their packages (jsonc-parser, vitest) as upstream's harness does, so
// bare imports from this repository's celld/ resolve from upstream's integration-tests package.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER_CELLD = resolve(HERE, "..");
const UPSTREAM = resolve(HERE, "../../cloudflare-os/packages/integration-tests");
const UPSTREAM_TESTS = join(UPSTREAM, "__tests__");

const runtime = process.env.CFOS_RUNTIME;
if (runtime !== "celld" && runtime !== "workerd") {
  throw new Error(`CFOS_RUNTIME must be celld or workerd (got ${JSON.stringify(runtime)}); ` +
      "run the suites through celld/integration.sh");
}

const REPLACED: Record<string, string> = {
  "../src/harness.js": join(HERE, "harness.ts"),
  "../src/network-interceptor.js": join(HERE, "network-interceptor.ts"),
};

const BARE = /^(?![./]|[a-zA-Z]:|node:|virtual:|\0)/;

const celldRuntime = {
  name: "cfos-runtime-celld",
  enforce: "pre" as const,
  async resolveId(
      this: { resolve(source: string, importer: string, options: object): Promise<unknown> },
      source: string, importer: string | undefined) {
    if (importer === undefined) return null;
    if (importer.startsWith(UPSTREAM_TESTS + "/") && source in REPLACED) return REPLACED[source];
    if (importer.startsWith(STARTER_CELLD + "/") && BARE.test(source)) {
      return this.resolve(source, join(UPSTREAM, "src/harness.ts"), { skipSelf: true });
    }
    return null;
  },
};

const jobs = Number(process.env.CELLD_INTEGRATION_JOBS ?? "1");
if (!Number.isInteger(jobs) || jobs < 1) throw new Error("CELLD_INTEGRATION_JOBS must be a positive integer");

export default {
  root: UPSTREAM,
  plugins: runtime === "celld" ? [celldRuntime] : [],
  test: {
    // Upstream's suites, and the adapter's own checks (celld only).
    include: ["__tests__/**/*.test.ts", ...(runtime === "celld" ? [join(HERE, "adapter.test.ts")] : [])],
    // Upstream's: it checks the prebuilt validated Worker trees and sets
    // WORKSHOP_INTEGRATION_PREBUILT, which both harnesses read.
    globalSetup: [join(UPSTREAM, "src/global-setup.ts")],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file starts its own node; how many run at once is the runner's choice.
    pool: "forks",
    maxWorkers: jobs,
    fileParallelism: jobs > 1,
  },
};
