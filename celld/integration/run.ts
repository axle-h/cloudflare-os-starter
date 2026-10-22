// Runs upstream's integration suites on celld and holds them to status.json (celld plan item 0.5).
// celld/integration.sh is the entry point; it builds the prerequisites and sources env.sh first.
//
// Usage: node celld/integration/run.ts [--update] [--workerd] [FILE...]
//
//   FILE       A suite under cloudflare-os/packages/integration-tests/__tests__, by file name
//              (`workshop-lifecycle.test.ts`, or `workshop-lifecycle`). Without any, every suite
//              status.json lists as passing or pending.
//   --update   Record each pending suite that passed as passing. status.json only grows: nothing
//              moves out of `passing` except by hand.
//   --workerd  Run the same suites on upstream's own harness (wrangler's createTestHarness), as the
//              reference. Nothing is compared with status.json.
//
// On celld the adapter's own checks (adapter.test.ts) run too, and the run fails if they do: a
// suite's result means nothing on a broken adapter. The run also fails on an error no test owned, on
// a suite with no result, and when vitest fails for anything but a pending, excluded or unlisted
// suite failing. A suite listed as passing that does not pass is run once more: it is a REGRESSION,
// or FLAKY if it passed the second time, and the run fails either way. A pending suite whose first
// error no longer contains the text status.json records for it (the part before " -> ") gets a
// warning. A pending or unlisted suite that passes is reported, and --update records it; an
// excluded one is only reported.
//
// Interrupted, it waits for vitest, then kills any process still running in a harness directory
// (a test process that was killed outright cannot stop its node), and exits as the signal says. Each harness keeps its generated configs, the
// node's state and `dev.log` under .celld/integration/<suite>-<random>/ until the next run.

import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
const STARTER = resolve(HERE, "../..");
const UPSTREAM = join(STARTER, "cloudflare-os/packages/integration-tests");
const STATUS = join(HERE, "status.json");
const STATE = process.env.CELLD_INTEGRATION_STATE ?? join(STARTER, ".celld/integration");
const SELF_TEST = "adapter.test.ts";
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

type Status = {
  $comment?: string[];
  /** Suites that pass on celld. Only grows. */
  passing: string[];
  /** Suites that do not pass yet: "<text of the first error> -> <what it maps to>". */
  pending: Record<string, string>;
  /** Suites the adapter does not run, with the reason. */
  excluded: Record<string, string>;
};

type VitestReport = {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { status: string; fullName: string; failureMessages?: string[] }[];
  }[];
};

type Result = { passed: boolean; error: string };
type Run = {
  status: number | null;
  signal: NodeJS.Signals | null;
  results: Map<string, Result>;
  unhandled: string[];
};

function die(message: string): never {
  console.error(`integration: error: ${message}`);
  process.exit(2);
}

function suiteName(arg: string): string {
  const name = arg.replace(/^.*\//, "");
  return name.endsWith(".test.ts") ? name : `${name}.test.ts`;
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const workerd = args.includes("--workerd");
for (const arg of args) {
  if (arg.startsWith("--") && arg !== "--update" && arg !== "--workerd") die(`unknown option ${arg}`);
}
if (update && workerd) die("--update records celld results; it does not combine with --workerd");

const status = JSON.parse(readFileSync(STATUS, "utf8")) as Status;
const named = args.filter(arg => !arg.startsWith("--")).map(suiteName);
const suites = named.length > 0 ? named : [...status.passing, ...Object.keys(status.pending)];
for (const suite of suites) {
  if (!existsSync(join(UPSTREAM, "__tests__", suite))) die(`no suite ${suite} in ${UPSTREAM}/__tests__`);
  if (suite in status.excluded) {
    console.error(`integration: note: ${suite} is excluded: ${status.excluded[suite]}`);
  }
}
if (suites.length === 0) die("no suites to run");

// Each run starts from no harness state; the last run's stays for reading until then.
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
const stateDir = realpathSync(STATE);

let interrupted: NodeJS.Signals | undefined;
let child: ReturnType<typeof spawn> | undefined;
for (const signal of SIGNALS) {
  process.on(signal, () => {
    interrupted ??= signal;
    // A terminal's Ctrl-C reaches vitest too; a signal sent to this process alone is passed on.
    child?.kill(signal);
  });
}

/** Kills every process whose working directory is a harness directory (Linux's /proc). */
function sweepLeftovers(): void {
  if (!existsSync("/proc")) return;
  const killed: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== stateDir && !cwd.startsWith(`${stateDir}/`)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // Gone already.
    }
  }
  if (killed.length > 0) {
    console.error(`integration: killed ${killed.length} leftover process(es) under ${STATE}: ${killed.join(" ")}`);
  }
}

function runVitest(label: string, files: string[], selfTest: boolean): Promise<Run> {
  const results = join(STATE, `results-${label}.json`);
  const unhandledPath = join(STATE, `unhandled-${label}.json`);
  return new Promise<Run>((resolveRun, reject) => {
    child = spawn(process.execPath, [
      join(UPSTREAM, "node_modules/vitest/vitest.mjs"), "run", "--config", join(HERE, "vitest.config.ts"),
      "--reporter=default", "--reporter=json", `--outputFile.json=${results}`,
      `--reporter=${join(HERE, "unhandled-reporter.ts")}`,
      ...(selfTest ? [join(HERE, SELF_TEST)] : []),
      ...files.map(suite => `__tests__/${suite}`),
    ], {
      cwd: UPSTREAM,
      stdio: "inherit",
      env: {
        ...process.env,
        CFOS_RUNTIME: workerd ? "workerd" : "celld",
        CELLD_INTEGRATION_STATE: STATE,
        CELLD_INTEGRATION_UNHANDLED: unhandledPath,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      child = undefined;
      const run: Run = { status: code, signal, results: new Map(), unhandled: [] };
      if (existsSync(results)) {
        const report = JSON.parse(readFileSync(results, "utf8")) as VitestReport;
        for (const file of report.testResults) {
          const failed = file.assertionResults.find(test => test.status === "failed");
          const message = file.message || failed?.failureMessages?.[0] || "";
          const firstLine = message.split("\n").find(line => line.trim() !== "")?.trim() ?? "";
          run.results.set(file.name.replace(/^.*\//, ""), {
            passed: file.status === "passed",
            error: failed && !file.message ? `${failed.fullName}: ${firstLine}` : firstLine,
          });
        }
      }
      if (existsSync(unhandledPath)) run.unhandled = JSON.parse(readFileSync(unhandledPath, "utf8"));
      resolveRun(run);
    });
  });
}

function expectation(suite: string): "passing" | "pending" | "excluded" | "unlisted" {
  return status.passing.includes(suite) ? "passing"
    : suite in status.pending ? "pending" : suite in status.excluded ? "excluded" : "unlisted";
}

async function main(): Promise<number> {
  const run = await runVitest("main", suites, !workerd);
  if (interrupted) return SIGNAL_EXIT[interrupted];
  if (run.results.size === 0) {
    console.error(`integration: vitest wrote no results (exit ${run.status ?? run.signal})`);
    return 1;
  }
  const failures: string[] = [];

  const selfTest = run.results.get(SELF_TEST);
  const adapterBroken = !workerd && !selfTest?.passed;
  const regressed: string[] = [];
  const newlyPassing: string[] = [];
  const passingExcluded: string[] = [];
  const drifted: string[] = [];
  const rows = suites.map(suite => {
    const result = run.results.get(suite);
    const expected = expectation(suite);
    const outcome = result === undefined ? "NO RESULT" : result.passed ? "PASS" : "FAIL";
    if (result === undefined) failures.push(`${suite} has no result`);
    if (!workerd && expected === "passing" && outcome === "FAIL") regressed.push(suite);
    if (!workerd && outcome === "PASS") {
      if (expected === "pending" || expected === "unlisted") newlyPassing.push(suite);
      if (expected === "excluded") passingExcluded.push(suite);
    }
    if (!workerd && expected === "pending" && outcome === "FAIL") {
      const recorded = status.pending[suite].split(" -> ")[0];
      if (!result!.error.includes(recorded)) drifted.push(`${suite}: recorded "${recorded}", now "${result!.error}"`);
    }
    return [suite, outcome, expected, result?.error ?? ""];
  });

  // A suite listed as passing that failed gets one more run, to tell a flake from a regression.
  const flaky: string[] = [];
  const regressions: string[] = [];
  if (regressed.length > 0) {
    console.error(`integration: running ${regressed.join(", ")} again, to tell a flake from a regression`);
    const again = await runVitest("rerun", regressed, false);
    if (interrupted) return SIGNAL_EXIT[interrupted];
    for (const suite of regressed) (again.results.get(suite)?.passed ? flaky : regressions).push(suite);
    for (const row of rows) if (flaky.includes(row[0])) row[1] = "FLAKY";
    run.unhandled.push(...again.unhandled);
  }

  const width = (column: number) => Math.max(...rows.map(row => row[column].length), 5);
  console.log(`\nintegration (${workerd ? "workerd reference" : "celld"}):`);
  if (!workerd) console.log(`  ${SELF_TEST} (the adapter's own checks): ${adapterBroken ? "FAIL" : "PASS"}`);
  for (const [suite, outcome, expected, error] of rows) {
    console.log(`  ${suite.padEnd(width(0))}  ${outcome.padEnd(9)}  ${expected.padEnd(8)}  ${error.slice(0, 160)}`);
  }
  console.log(`Harness logs: ${STATE}/<suite>-*/dev.log`);

  for (const line of drifted) console.error(`integration: warning: a pending suite's first error changed: ${line}`);
  if (passingExcluded.length > 0) {
    console.log(`Excluded, but passed (not recorded; reconsider the exclusion): ${passingExcluded.join(", ")}`);
  }
  if (newlyPassing.length > 0) {
    if (update) {
      status.passing = [...new Set([...status.passing, ...newlyPassing])].sort();
      for (const suite of newlyPassing) delete status.pending[suite];
      writeFileSync(STATUS, JSON.stringify(status, null, 2) + "\n");
      console.log(`Recorded as passing in status.json: ${newlyPassing.join(", ")}`);
    } else {
      console.log(`Now passing, not yet in status.json (record with --update): ${newlyPassing.join(", ")}`);
    }
  }

  if (adapterBroken) {
    failures.push(`the adapter's own checks (${SELF_TEST}) failed: ${selfTest?.error || "no result"}; ` +
        "the suite results mean nothing until they pass");
  }
  if (regressions.length > 0) failures.push(`REGRESSION: listed as passing, failed twice: ${regressions.join(", ")}`);
  if (flaky.length > 0) failures.push(`FLAKY: listed as passing, failed once, then passed: ${flaky.join(", ")}`);
  if (run.unhandled.length > 0) {
    failures.push(`${run.unhandled.length} error(s) no test owned: ${run.unhandled.join(" | ").slice(0, 500)}`);
  }
  if (run.signal !== null) failures.push(`vitest was killed by ${run.signal}`);
  // vitest fails whenever any suite fails. That is expected of pending, excluded and unlisted
  // suites (on workerd, of none); anything else is unexplained.
  const explained = [...run.results].filter(([, result]) => !result.passed)
      .every(([suite]) => !workerd && suite !== SELF_TEST && expectation(suite) !== "passing");
  const anyFailed = [...run.results.values()].some(result => !result.passed);
  if (run.status !== 0 && run.status !== null && !(anyFailed && explained)) {
    failures.push(`vitest exited with ${run.status}${anyFailed ? "" : ", with no suite failing"}`);
  }

  for (const failure of failures) console.error(`integration: ${failure}`);
  return failures.length > 0 ? 1 : 0;
}

let code: number;
try {
  code = await main();
} finally {
  sweepLeftovers();
}
process.exit(code);
