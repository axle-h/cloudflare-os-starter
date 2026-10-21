// Browser test of Cloudflare OS on celld: a headless Chromium through the Workshop UI, step 7 of
// plan item 0.4 (celld's plans/cloudflare-os-fixes.md). Log in, see the home page, send "hello"
// and see the mock's reply, turn a gatekeeper on, and create a gadget from a blueprint.
//
// Usage: node celld/e2e/browser.ts ORIGIN
//
// A step fails on its own error, on a console error or uncaught page error outside ALLOWED, and on
// an /api WebSocket that closes with 1006. Each step's screenshot goes to .celld/e2e/shots/. B6
// scans the node.log the run produced, as smoke's S11 does.
// Uses playwright-core 1.64 from the submodule's install and the Chromium it expects in
// ~/.cache/ms-playwright/. Exits 1 if any step failed.

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  capnweb, ensureModel, mock, NodeLog, root, runSteps, scanNodeLog, signIn, skip, sleep, STATE,
  summarize, USERNAME, type Results, type Step,
} from "./workshop.ts";
import type { PublicApi } from "../../cloudflare-os/packages/workshop-shared/src/api.ts";

const PLAYWRIGHT = join(root, "cloudflare-os/node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core");
const SHOTS = join(STATE, "shots");

/** Console errors the app logs on celld and on Cloudflare alike (see celld's cloudflare-os-trial.md). */
const ALLOWED = [
  "useAuthenticatedApi must be used within an AuthProvider",
  "Flagship binding missing",
];

/** The reply the mock LLM gives to the browser's "hello". */
const REPLY = "Hello from the browser e2e mock.";
/** The gatekeeper onboarding leaves off, for the Gatekeepers page to turn on. */
const GATEKEEPER = "Web Search";

const [origin, ...rest] = process.argv.slice(2);
if (!origin || rest.length) throw new Error("usage: node celld/e2e/browser.ts ORIGIN");

if (!existsSync(join(PLAYWRIGHT, "package.json"))) {
  throw new Error(`no playwright-core 1.64.0 at ${PLAYWRIGHT}; run pnpm install`);
}
const { chromium } = createRequire(join(PLAYWRIGHT, "package.json"))("playwright-core") as typeof import("playwright-core");
mkdirSync(SHOTS, { recursive: true });

// --- what the page reports ----------------------------------------------------------------------

/** Console errors, uncaught page errors and abnormal /api closes since the last step ended. */
let problems: string[] = [];
/** How many /api WebSockets closed with 1006 in the whole run (for B6's log scan). */
let closed1006 = 0;
const nodeLog = new NodeLog();
nodeLog.start();

function firstLine(text: string): string {
  return text.split("\n", 1)[0].slice(0, 300);
}

let browser: Awaited<ReturnType<typeof chromium.launch>>;
try {
  browser = await chromium.launch();
} catch (error) {
  console.error(`browser: could not start Chromium: ${String(error)}`);
  console.error(`browser: install the Chromium playwright-core 1.64 expects with: node ${PLAYWRIGHT}/cli.js install chromium`);
  process.exit(1);
}
const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20_000);
page.on("console", message => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (!ALLOWED.some(allowed => text.includes(allowed))) problems.push(`console error: ${firstLine(text)}`);
});
page.on("pageerror", error => problems.push(`page error: ${firstLine(String(error))}`));
// Playwright does not report close codes, so the page reports them itself.
await page.exposeFunction("__e2eWebSocketClosed", (url: string, code: number, reason: string) => {
  if (code === 1006 && new URL(url).pathname === "/api") {
    closed1006++;
    problems.push(`/api WebSocket closed with 1006 ${reason}`.trim());
  }
});
await page.addInitScript(() => {
  type Reporter = { __e2eWebSocketClosed(url: string, code: number, reason: string): Promise<void> };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("close", event => {
        void (window as unknown as Reporter).__e2eWebSocketClosed(this.url, event.code, event.reason);
      });
    }
  };
});

// --- steps --------------------------------------------------------------------------------------

/**
 * Waits for `done`, but gives up early once the page reports a problem: the step then fails with
 * what the page reported (runSteps prints it) instead of waiting out its timeout.
 */
async function unlessProblem<T>(done: Promise<T>, what: string, signal: AbortSignal): Promise<T> {
  const seen = problems.length;
  let poll: NodeJS.Timeout | undefined;
  const problem = new Promise<never>((_, reject) => {
    poll = setInterval(() => {
      if (signal.aborted) reject(signal.reason);
      else if (problems.length > seen) reject(new Error(`the page reported an error while waiting for ${what}`));
    }, 200);
  });
  try {
    return await Promise.race([done, problem]);
  } finally {
    clearInterval(poll);
  }
}

const home = () => page.getByRole("heading", { name: "What are we working on?" });

/** Reloads the home page, so a step starts clean, and lets its load-time errors arrive first. */
async function reloadHome(): Promise<void> {
  await page.goto(origin);
  await home().waitFor();
  await sleep(1500);
}
const onboarding = () => page.getByRole("heading", { name: "Let's set you up" });

const steps: Step[] = [
  {
    id: "B0", title: `the ${USERNAME} account and the scripted model exist (over the API)`,
    covers: "trial 5 (router mode)",
    needs: [], timeoutMs: 60_000,
    async run() {
      const ws = origin.replace(/^http/, "ws") + "/api";
      using publicApi = capnweb.newWebSocketRpcSession<PublicApi>(ws);
      using api = await signIn(publicApi);
      await ensureModel(api);
    },
  },
  {
    id: "B1", title: "log in", covers: "trial 5 (router mode)",
    needs: ["B0"], timeoutMs: 60_000,
    async run() {
      await page.goto(origin);
      await page.getByLabel("Username").fill(USERNAME);
      await page.getByLabel("Password").fill(process.env.CFOS_TRIAL_PASSWORD!);
      await page.getByRole("button", { name: "Sign in" }).click();
      await home().or(onboarding()).waitFor({ timeout: 30_000 });
    },
  },
  {
    id: "B2", title: "home renders (finishing onboarding on the first visit)", covers: "trial 6, 7",
    needs: ["B1"], timeoutMs: 60_000,
    async run(signal) {
      let note = "";
      if (await onboarding().isVisible()) {
        // Leave one built-in tool off, so B4 has one to turn on.
        const tool = page.getByRole("switch", { name: GATEKEEPER });
        if (await tool.isChecked()) await tool.click();
        const next = page.getByRole("button", { name: "Next" });
        // The wizard has four pages; the bound and the signal keep a stuck one from looping.
        for (let pages = 0; await next.isVisible(); pages++) {
          signal.throwIfAborted();
          if (pages === 10) throw new Error("onboarding still shows Next after 10 pages");
          await next.click();
        }
        await page.getByRole("button", { name: "Let's build" }).click();
        note = `onboarding finished with ${GATEKEEPER} off`;
      }
      await home().waitFor({ timeout: 30_000 });
      return note;
    },
  },
  {
    id: "B3", title: "send \"hello\" and see the mock's reply", covers: "trial 6",
    needs: ["B2"], timeoutMs: 90_000,
    async run(signal) {
      await mock("/__reset", {});
      await mock("/__script", { text: REPLY });
      await reloadHome();
      await page.getByRole("combobox", { name: "Start a new conversation…" }).fill("hello");
      await page.getByRole("button", { name: "Send message" }).click();
      await unlessProblem(page.getByText(REPLY).waitFor({ timeout: 60_000 }), "the reply", signal);
    },
  },
  {
    id: "B4", title: `Gatekeepers page: turn ${GATEKEEPER} on`, covers: "trial 6, 7",
    needs: ["B2"], timeoutMs: 60_000,
    async run(signal) {
      await reloadHome();
      await page.getByRole("link", { name: "Gatekeepers" }).click();
      await page.getByRole("heading", { name: "Gatekeepers", level: 1 }).waitFor();
      const section = (heading: RegExp) => page.locator("section", { has: page.getByRole("heading", { name: heading }) });
      const card = section(/^Available/).getByRole("button", { name: new RegExp(`^${GATEKEEPER}`) });
      const connected = section(/^Connected/).getByText(GATEKEEPER, { exact: true }).first();
      try {
        await card.or(connected).first().waitFor({ timeout: 10_000 });
      } catch {
        throw new Error(`${GATEKEEPER} is listed neither under Available nor under Connected`);
      }
      if (!await card.isVisible()) skip(`${GATEKEEPER} is already under Connected, from an earlier run`);
      await card.click();
      await page.getByRole("dialog", { name: `Connect ${GATEKEEPER}` })
        .getByRole("button", { name: `Add ${GATEKEEPER}` }).click();
      await unlessProblem(connected.waitFor({ timeout: 15_000 }), `${GATEKEEPER} under Connected`, signal);
    },
  },
  {
    id: "B5", title: "create a gadget from a featured blueprint", covers: "trial 9",
    needs: ["B2"], timeoutMs: 90_000,
    async run(signal) {
      await reloadHome();
      await page.getByRole("link", { name: "Explore", exact: true }).click();
      const blueprint = page.getByRole("link", { name: /^Open featured blueprint / }).first();
      const name = (await blueprint.getAttribute("aria-label")) ?? (await blueprint.innerText());
      await blueprint.click();
      await page.getByRole("button", { name: "Create Gadget" }).click();
      // The landing page shows a failure in a banner (BlueprintLandingPage.tsx), not the console.
      const banner = page.locator("main .bg-kumo-danger-tint span").first();
      const failed = banner.waitFor({ timeout: 60_000 }).then(async () => {
        throw new Error(`the blueprint page shows "${await banner.innerText()}"`);
      });
      failed.catch(() => {}); // the race reports it; once the URL has won, it is moot
      await unlessProblem(Promise.race([page.waitForURL(/\/workspace\//, { timeout: 60_000 }), failed]),
          "the new workspace", signal);
      return `${name.replace(/^Open featured blueprint /, "")}: ${new URL(page.url()).pathname}`;
    },
  },
  {
    id: "B6", title: "node.log has none of the known failure messages", covers: "all",
    needs: [], timeoutMs: 15_000,
    async run() {
      await page.close();
      // Give celld a moment to log the page's sessions ending.
      await sleep(1000);
      const found = scanNodeLog(nodeLog.text(), closed1006);
      if (found.length) throw new Error("\n    " + found.join("\n    "));
    },
  },
];

const results: Results = new Map();
console.log(`browser: ${origin}; screenshots in ${SHOTS}`);
await runSteps(steps, results, async step => {
  if (step.id === "B0" || step.id === "B6") return;
  // Errors from the step's last calls arrive a moment after it ends.
  await sleep(1500);
  await page.screenshot({ path: join(SHOTS, `${step.id}.png`) }).catch(() => {});
  const found = problems;
  problems = [];
  if (found.length) return found.join("\n    ");
});
await browser.close();
process.exit(summarize("browser", results, steps.map(step => step.id)) ? 1 : 0);
