// Smoke test of Cloudflare OS on celld: drives the Workshop over Cap'n Web from Node, as the
// browser does, through steps S0-S13 of plan item 0.4 (celld's plans/cloudflare-os-fixes.md).
//
// Usage: node celld/e2e/smoke.ts ORIGIN [--router] [--dev-store] [--quick]
//   --router     the node runs with the router as the primary Worker (e2e.sh's default, which
//                passes this unless --no-router); enables S10.
//   --dev-store  the node is a `celld dev`; only passed on to `e2e.sh restart` for S9.
//   --quick      skip S12, which waits more than 60 s.
//
// celld/e2e.sh smoke runs this with the options of the running node. Each step prints PASS, FAIL
// or SKIP with what it covers (a trial failure from celld's plans/cloudflare-os-trial.md, or a
// plan learning N1-N12). A step whose prerequisite did not pass is skipped, not run into a
// confusing error. Exits 1 if any step failed.
//
// Environment: CFOS_TRIAL_USER and CFOS_TRIAL_PASSWORD (celld/env.sh) are the admin account, which
// is created on first use; MOCK_LLM_PORT is the mock LLM (celld/mock-llm.ts); E2E_STATE is the
// harness's state directory (default .celld/e2e), whose node.log S11 scans.

import { spawn } from "node:child_process";
import type {
  AdminApi, AiChatMessage, AmbientGatekeeperMode, AuthenticatedApi, ConnectedAccountsSubscriber,
  GadgetMetadata, NotificationSubscriber, Overseer, PublicApi, UserNotification,
} from "../../cloudflare-os/packages/workshop-shared/src/api.ts";
import type { AccountDescription } from "../../cloudflare-os/packages/workshop-shared/src/gatekeeper.ts";
import type { RpcStub } from "capnweb";
import {
  agentRequests, capnweb, contentText, ensureModel, mock, MODEL_PROFILE, NodeLog, root, runSteps,
  scanNodeLog, signIn, skip, sleep, summarize, USERNAME, waitFor, withTimeout, type Results, type Step,
} from "./workshop.ts";

const { RpcStub: Stub, RpcTarget, newHttpBatchRpcSession, newWebSocketRpcSession } = capnweb;

const args = process.argv.slice(2);
const origin = args.find(arg => !arg.startsWith("--"));
const KNOWN = new Set(["--router", "--dev-store", "--quick"]);
for (const arg of args) {
  if (arg.startsWith("--") && !KNOWN.has(arg)) throw new Error(`smoke.ts: unknown option ${arg}`);
}
if (!origin) throw new Error("usage: node celld/e2e/smoke.ts ORIGIN [--router] [--dev-store] [--quick]");
const router = args.includes("--router");
const devStore = args.includes("--dev-store");
const quick = args.includes("--quick");

const wsUrl = origin.replace(/^http/, "ws") + "/api";

/** The format whose gadget has getDocument() (bundled-blueprints/blueprints/workspace-docs). */
const DOCUMENT_BLUEPRINT = "format.document";
/** The reply S6 scripts, and expects in the chat. */
const S6_REPLY = "hello from the e2e mock";
/**
 * The gatekeeper S2 moves off the default mode ("optional", cos:workshop-backend/src/
 * provisioning-policy.ts), so S9 can tell the setting survived a restart. Nothing else uses it.
 */
const MOVED_VENDOR = "custom";
const MOVED_MODE: AmbientGatekeeperMode = "disabled";

// --- sessions -----------------------------------------------------------------------------------

/** One Cap'n Web session over its own WebSocket, so that the close code is known. */
class Session {
  static all: Session[] = [];
  readonly label: string;
  readonly ws: WebSocket;
  readonly api: RpcStub<PublicApi>;
  closeCode: number | undefined;
  #disposed = false;

  constructor(label: string) {
    this.label = label;
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("close", event => { this.closeCode = event.code; });
    this.api = newWebSocketRpcSession<PublicApi>(this.ws);
    Session.all.push(this);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.api[Symbol.dispose]();
  }

  static readonly CLOSE_TIMEOUT_MS = 10_000;

  /** Disposes every session, waits for its socket to close, and returns those that did not. */
  static async closeAll(): Promise<Session[]> {
    for (const session of Session.all) session.dispose();
    const open = () => Session.all.filter(session => session.ws.readyState !== WebSocket.CLOSED);
    await waitFor("every /api WebSocket to close", async () => open().length === 0 || null,
        Session.CLOSE_TIMEOUT_MS).catch(() => {});
    return open();
  }
}

type Account = { id: number; vendorId: string; description: AccountDescription };

class AccountsSubscriber extends RpcTarget implements ConnectedAccountsSubscriber {
  readonly accounts = new Map<number, Account>();
  /** Resolves at the first ready(). */
  readonly readyDone = Promise.withResolvers<void>();
  add(id: number, description: AccountDescription, _vendor: unknown, _resources: unknown,
      _credentialsValid: boolean, vendorId: string): void {
    this.accounts.set(id, { id, vendorId, description });
  }
  remove(id: number): void { this.accounts.delete(id); }
  ready(): void { this.readyDone.resolve(); }
  find(vendorId: string): Account | undefined {
    return [...this.accounts.values()].find(account => account.vendorId === vendorId);
  }
}

// --- chats and accounts -------------------------------------------------------------------------

/** The result the agent got back for tool call `id`, from the next model request. */
async function toolResult(id: string, timeoutMs: number): Promise<string> {
  return waitFor(`the result of tool call ${id} to reach the model`, async () => {
    for (const request of await agentRequests()) {
      const message = request.body.messages?.find(m => m.role === "tool" && m.tool_call_id === id);
      if (message) return contentText(message.content);
    }
    return null;
  }, timeoutMs);
}

/** Waits until chat `chatId` exists with no agent running. */
async function waitForIdle(ws: RpcStub<Overseer>, chatId: number, timeoutMs: number): Promise<void> {
  await waitFor(`chat ${chatId} to go idle`, async () => {
    const chat = (await ws.listChats()).find(entry => entry.id === chatId);
    return (chat !== undefined && chat.activeAgent === undefined) || null;
  }, timeoutMs);
}

/** Subscribes to the connected accounts and returns the subscriber once ready() arrives. */
async function subscribeAccounts(api: RpcStub<AuthenticatedApi>, timeoutMs: number)
    : Promise<{ subscriber: AccountsSubscriber; subscription: RpcStub<{}>; stub: RpcStub<AccountsSubscriber> }> {
  const subscriber = new AccountsSubscriber();
  const stub = new Stub(subscriber) as unknown as RpcStub<AccountsSubscriber>;
  const subscription = await withTimeout(
      api.subscribeConnectedAccounts(stub as never), timeoutMs, "subscribeConnectedAccounts()");
  await withTimeout(subscriber.readyDone.promise, timeoutMs, "ready() on the accounts subscriber");
  return { subscriber, subscription, stub };
}

/** Every message of a chat, oldest first, across compaction checkpoints. */
async function chatHistory(ws: RpcStub<Overseer>, chatId: number): Promise<AiChatMessage[]> {
  let page = await ws.getChatHistory(chatId);
  let messages = page.messages;
  while (page.compacted !== undefined) {
    page = await ws.getChatHistory(chatId, page.compacted.to);
    messages = [...page.messages, ...messages];
  }
  return messages;
}

/** The chat's error messages, as "error: …" lines. */
function chatErrors(messages: AiChatMessage[]): string[] {
  return messages.flatMap(message => message.type === "error" ? [`chat error: ${message.message}`] : []);
}

const nodeLog = new NodeLog();

// --- steps --------------------------------------------------------------------------------------

/** Filled in as the steps run; S9 and S10 read earlier results. */
const results: Results = new Map();

// State the steps share.
let main: Session;
let api: RpcStub<AuthenticatedApi>;
let accounts: Awaited<ReturnType<typeof subscribeAccounts>> | undefined;
let chatWorkspace: { id: string; chatId: number } | undefined;
let blueprintWorkspace: { id: string; blueprintId: string } | undefined;

const steps: Step[] = [
  {
    id: "S0", title: "GET / returns HTML; ping() as an HTTP batch through POST /api", covers: "",
    needs: [], timeoutMs: 30_000,
    async run() {
      const response = await fetch(`${origin}/`);
      const type = response.headers.get("content-type") ?? "";
      const body = await response.text();
      if (response.status !== 200 || !type.startsWith("text/html")) {
        throw new Error(`GET /: status ${response.status}, content-type ${JSON.stringify(type)}: ${body.slice(0, 200)}`);
      }
      // A Cap'n Web HTTP batch is JSON both ways; through the router it crosses the
      // WORKSHOP_BACKEND service binding as plain HTTP.
      using batch = newHttpBatchRpcSession<PublicApi>(`${origin}/api`);
      await batch.ping();
      return `served by the ${router ? "router" : "workshop"}`;
    },
  },
  {
    id: "S1", title: "sign in; amIAdmin() and getAdminApi()", covers: "trial 5 (with --router)",
    needs: ["S0"], timeoutMs: 60_000,
    async run() {
      main = new Session("main");
      api = await signIn(main.api);
      if (await api.amIAdmin() !== true) throw new Error(`amIAdmin() is not true for ${USERNAME}`);
      using admin = await api.getAdminApi();
      if (admin === null) throw new Error("getAdminApi() returned null");
      return `signed in as ${USERNAME}`;
    },
  },
  {
    id: "S2", title: `admin.setGatekeeperMode for each built-in gatekeeper: "optional", ${MOVED_VENDOR} "${MOVED_MODE}"`,
    covers: "",
    needs: ["S1"], timeoutMs: 60_000,
    async run() {
      using admin = await api.getAdminApi() as RpcStub<AdminApi>;
      const settings = await admin.getSettings();
      const ambient = settings.resourceVendors.filter(vendor => vendor.autoProvisions);
      if (!ambient.some(vendor => vendor.vendorId === MOVED_VENDOR)) {
        const vendors = settings.resourceVendors.map(vendor => vendor.vendorId);
        throw new Error(`no auto-provisioning gatekeeper "${MOVED_VENDOR}" among ${JSON.stringify(vendors)}`);
      }
      // "optional" is the default, so only MOVED_VENDOR's mode shows the setter took effect.
      const wanted = (vendorId: string): AmbientGatekeeperMode => vendorId === MOVED_VENDOR ? MOVED_MODE : "optional";
      for (const vendor of ambient) await admin.setGatekeeperMode(vendor.vendorId, wanted(vendor.vendorId));
      const after = await admin.getSettings();
      const wrong = after.resourceVendors.filter(vendor => ambient.some(a => a.vendorId === vendor.vendorId)
          && (!vendor.autoProvisions || vendor.ambientMode !== wanted(vendor.vendorId)));
      if (wrong.length) throw new Error(`modes not applied: ${JSON.stringify(wrong)}`);
      return ambient.map(vendor => `${vendor.vendorId} ${wanted(vendor.vendorId)}`).join(", ");
    },
  },
  {
    id: "S3", title: "subscribeToNotifications(new RpcStub(sub)); dispose", covers: "trial 6, 8",
    needs: ["S1"], timeoutMs: 20_000,
    async run() {
      class Subscriber extends RpcTarget implements NotificationSubscriber {
        async notify(_notification: UserNotification): Promise<void> {}
      }
      const stub = new Stub(new Subscriber()) as unknown as RpcStub<NotificationSubscriber>;
      const subscription = await api.subscribeToNotifications(stub);
      subscription[Symbol.dispose]();
      stub[Symbol.dispose]();
      // The disposal is asynchronous; a round trip after it shows the session survived.
      await api.whoami();
    },
  },
  {
    id: "S4", title: "subscribeConnectedAccounts(sub): ready() within 10 s", covers: "trial 6",
    needs: ["S1"], timeoutMs: 15_000,
    async run() {
      accounts = await subscribeAccounts(api, 10_000);
      const vendors = [...accounts.subscriber.accounts.values()].map(account => account.vendorId);
      return `${vendors.length} account(s)${vendors.length ? `: ${vendors.join(", ")}` : ""}`;
    },
  },
  {
    id: "S5", title: "provisionAmbientAccount(\"context\") arrives on S4's subscriber", covers: "trial 7",
    needs: ["S2", "S4"], timeoutMs: 30_000,
    async run() {
      const subscriber = accounts!.subscriber;
      if (subscriber.find("context")) {
        skip("the context account exists from an earlier run on this bucket; use --fresh to see it arrive");
      }
      await api.provisionAmbientAccount("context");
      await waitFor("the context account on S4's subscriber", async () => subscriber.find("context") ?? null, 20_000);
    },
  },
  {
    id: "S6", title: "newGadget().newChat(\"hello\", \"scripted\"), pipelined; the mock's reply is in the chat",
    covers: "trial 6",
    needs: ["S1"], timeoutMs: 90_000,
    async run() {
      await ensureModel(api);
      await mock("/__reset", {});
      await mock("/__script", { text: S6_REPLY });
      using ws = api.newGadget() as unknown as RpcStub<Overseer>;
      const chatId = await ws.newChat("hello", MODEL_PROFILE.id);
      if (typeof chatId !== "number") throw new Error(`newChat() returned ${JSON.stringify(chatId)}, not a chat id`);
      const { id } = await ws.getMetadata();
      await waitFor("the model to be called with \"hello\"", async () =>
        (await agentRequests()).some(request =>
          request.body.messages?.some(m => m.role === "user" && contentText(m.content).includes("hello"))) || null,
      30_000);
      await waitForIdle(ws, chatId, 40_000);
      const messages = await chatHistory(ws, chatId);
      const errors = chatErrors(messages);
      if (errors.length) throw new Error(errors.join("; "));
      const replied = messages.some(message =>
        message.type === "message" && message.author.type === "agent" && message.message === S6_REPLY);
      if (!replied) {
        throw new Error(`the chat has no agent message "${S6_REPLY}": ${JSON.stringify(messages).slice(0, 500)}`);
      }
      chatWorkspace = { id, chatId };
      return `workspace ${id}, chat ${chatId}`;
    },
  },
  {
    id: "S7", title: "newGadgetFromBlueprint(listFeaturedBlueprints()[0].id, {}); getMetadata()", covers: "trial 9",
    needs: ["S1"], timeoutMs: 90_000,
    async run() {
      const featured = await api.listFeaturedBlueprints();
      if (featured.length === 0) throw new Error("listFeaturedBlueprints() is empty");
      const blueprintId = featured[0].id;
      using ws = api.newGadgetFromBlueprint(blueprintId, {}) as unknown as RpcStub<Overseer>;
      const metadata: GadgetMetadata = await ws.getMetadata();
      if (!metadata.title) throw new Error(`the workspace has no title: ${JSON.stringify(metadata)}`);
      blueprintWorkspace = { id: metadata.id, blueprintId };
      return `${blueprintId}: "${metadata.title}"`;
    },
  },
  {
    id: "S8",
    title: "scripted tool call schedules a one-shot task; the alarm fires; the hook message reaches the chat",
    covers: "J5 (Phases 3-5)",
    needs: ["S5", "S6"], timeoutMs: 240_000,
    async run() {
      const subscriber = accounts!.subscriber;
      if (!subscriber.find("scheduler")) {
        await api.provisionAmbientAccount("scheduler");
        await waitFor("the scheduler account", async () => subscriber.find("scheduler") ?? null, 20_000);
      }
      // The schedule only runs once its hook is enabled, which happens after the turn. A one-shot
      // whose time passed before that never runs, so the time is fixed here, far enough out, and
      // the step fails outright (rather than flaking) if enabling the hook comes too close to it.
      const fireAt = Date.now() + 60_000;
      const code = `export default async function(self, env) {
  const id = await env.SCHEDULER.runAt(${fireAt}, self,
      { title: "e2e S8", description: "celld e2e smoke: fires once" });
  console.log("scheduled " + id);
}`;
      await mock("/__reset", {});
      await mock("/__script", [
        { toolCall: { id: "s8-schedule", name: "executeCode", arguments: { code } } },
        { text: "Scheduled." },
      ]);
      // The ambient account is wired into a workspace when it opens, so open a new one now.
      using ws = api.newGadget() as unknown as RpcStub<Overseer>;
      const chatId = await ws.newChat("Schedule a task.", MODEL_PROFILE.id);
      const result = await toolResult("s8-schedule", 40_000);
      if (!result.includes("scheduled ")) throw new Error(`executeCode did not schedule: ${result.slice(0, 500)}`);
      await waitForIdle(ws, chatId, 40_000);
      const hooks = await ws.listHooks();
      if (hooks.length !== 1) throw new Error(`expected one hook, listHooks() gave ${JSON.stringify(hooks)}`);
      await ws.enableHook(hooks[0].id);
      const margin = fireAt - Date.now();
      if (margin < 5_000) throw new Error(`the hook was enabled only ${margin} ms before the fire time`);
      // The callback lands in the chat as an agentCallback message for self.onSchedule().
      const callback = await waitFor("the onSchedule callback in the chat", async () =>
        (await chatHistory(ws, chatId)).find(message =>
          message.type === "agentCallback" && message.methodName === "onSchedule") ?? null,
      margin + 60_000);
      const errors = chatErrors(await chatHistory(ws, chatId));
      if (errors.length) throw new Error(errors.join("; "));
      return `fired ${Math.round((callback.timestamp.valueOf() - fireAt) / 1000)} s after its time`;
    },
  },
  {
    id: "S13", title: "scripted code-mode call env.GADGET.rpc.getDocument()", covers: "N2, N6",
    needs: ["S6", "S7"], timeoutMs: 120_000,
    async run() {
      let workspaceId = blueprintWorkspace!.blueprintId === DOCUMENT_BLUEPRINT ? blueprintWorkspace!.id : undefined;
      if (workspaceId === undefined) {
        using created = api.newGadgetFromBlueprint(DOCUMENT_BLUEPRINT, {}) as unknown as RpcStub<Overseer>;
        workspaceId = (await created.getMetadata()).id;
      }
      // A blueprint's workspace has one gadget, bound as GADGET (Overseer.ensureDefaultGadget);
      // in executeCode its `rpc` property is the stub to the gadget's Durable Object.
      const code = `export default async function(self, env) {
  console.log("document " + JSON.stringify(await env.GADGET.rpc.getDocument()));
}`;
      await mock("/__reset", {});
      await mock("/__script", [
        { toolCall: { id: "s13-document", name: "executeCode", arguments: { code } } },
        { text: "Read it." },
      ]);
      using ws = api.openGadget(workspaceId) as unknown as RpcStub<Overseer>;
      const chatId = await ws.newChat("Read the document.", MODEL_PROFILE.id);
      const result = await toolResult("s13-document", 60_000);
      if (!/document \{.*"revision"/s.test(result)) {
        throw new Error(`getDocument() did not return the document: ${result.slice(0, 500)}`);
      }
      await waitForIdle(ws, chatId, 40_000);
    },
  },
  {
    id: "S12", title: "two sessions on one workspace; wait 65 s; setTitle in one, the other sees it",
    covers: "N5, N12",
    needs: ["S6"], timeoutMs: 120_000,
    async run() {
      if (quick) skip("--quick");
      const a = new Session("S12 a");
      const b = new Session("S12 b");
      try {
        using apiA = await signIn(a.api);
        using apiB = await signIn(b.api);
        using wsA = apiA.openGadget(chatWorkspace!.id) as unknown as RpcStub<Overseer>;
        using wsB = apiB.openGadget(chatWorkspace!.id) as unknown as RpcStub<Overseer>;
        const seen: string[] = [];
        const callback = new Stub((metadata: GadgetMetadata) => { seen.push(metadata.title); });
        using _subscription = await wsB.subscribeToMetadata(callback as never);
        await waitFor("the first metadata callback", async () => seen.length > 0 || null, 10_000);
        const logBefore = nodeLog.text().length;
        await sleep(65_000);
        const title = `e2e S12 ${Date.now()}`;
        await wsA.setTitle(title);
        await waitFor(`session b to see the title "${title}"`, async () => seen.includes(title) || null, 15_000);
        // celld logs "isolate retiring isolate=<heap>" (pool.rs), but nothing ties an /api session
        // to its isolate, so a retirement during the wait is the most this can show.
        const retired = nodeLog.text().slice(logBefore).split("\n")
          .filter(line => line.includes("isolate retiring")).length;
        return `${retired} isolate(s) retired during the wait; not confirmed that the sessions' isolate was one (celld does not log which isolate serves an /api session)`;
      } finally {
        a.dispose();
        b.dispose();
      }
    },
  },
  {
    id: "S9", title: `restart the node; sign in; S2's ${MOVED_VENDOR} mode, S5's account and S6's chat survive`,
    covers: "durable stubs, restore", needs: ["S1"], timeoutMs: 300_000,
    async run(signal) {
      const checkMode = results.get("S2")?.status === "PASS";
      const checkAccount = results.get("S5")?.status === "PASS";
      const checkWorkspace = results.get("S6")?.status === "PASS";
      accounts?.subscription[Symbol.dispose]();
      accounts = undefined;
      const unclosed = await Session.closeAll();
      if (unclosed.length) throw new Error(`sessions still open before the restart: ${unclosed.map(s => s.label).join(", ")}`);
      const restartArgs = ["celld/e2e.sh", "restart",
        ...(router ? [] : ["--no-router"]), ...(devStore ? ["--dev-store"] : [])];
      nodeLog.beforeRestart();
      try {
        await new Promise<void>((resolve, reject) => {
          // Its own process group, so a timeout can stop the script and whatever it started.
          const child = spawn("bash", restartArgs, { cwd: root, stdio: ["ignore", "inherit", "inherit"], detached: true });
          const kill = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
          signal.addEventListener("abort", kill, { once: true });
          child.on("error", reject);
          child.on("exit", code => {
            signal.removeEventListener("abort", kill);
            code === 0 ? resolve() : reject(new Error(`${restartArgs.join(" ")} exited ${code}`));
          });
        });
      } finally {
        nodeLog.afterRestart();
      }
      main = new Session("main after restart");
      api = await signIn(main.api);
      const notes = ["signed in"];
      if (checkMode) {
        using admin = await api.getAdminApi() as RpcStub<AdminApi>;
        try {
          const vendor = (await admin.getSettings()).resourceVendors.find(v => v.vendorId === MOVED_VENDOR);
          const mode = vendor?.autoProvisions ? vendor.ambientMode : undefined;
          if (mode !== MOVED_MODE) throw new Error(`${MOVED_VENDOR}'s mode is ${mode} after the restart, not ${MOVED_MODE}`);
          notes.push(`${MOVED_VENDOR} still ${MOVED_MODE}`);
        } finally {
          // Back to the default, which the browser's onboarding expects.
          await admin.setGatekeeperMode(MOVED_VENDOR, "optional");
        }
      } else {
        notes.push("no S2 mode to check");
      }
      if (checkAccount) {
        accounts = await subscribeAccounts(api, 10_000);
        if (!accounts.subscriber.find("context")) {
          const listed = [...accounts.subscriber.accounts.values()].map(account => account.vendorId);
          throw new Error(`the context account is gone after the restart; listed: ${JSON.stringify(listed)}`);
        }
        notes.push("S5's account listed");
      } else {
        notes.push("no S5 account to check");
      }
      if (checkWorkspace) {
        using ws = api.openGadget(chatWorkspace!.id) as unknown as RpcStub<Overseer>;
        const messages = await chatHistory(ws, chatWorkspace!.chatId);
        if (!messages.some(message => message.type === "message" && message.message === S6_REPLY)) {
          throw new Error(`S6's chat ${chatWorkspace!.chatId} lost its reply: ${JSON.stringify(messages).slice(0, 500)}`);
        }
        notes.push("S6's chat reopened");
      } else {
        notes.push("no S6 chat to reopen");
      }
      return notes.join("; ");
    },
  },
  {
    id: "S10", title: "S1-S7 through the router", covers: "trial 5",
    needs: [], timeoutMs: 1_000,
    async run() {
      if (!router) skip("runs only in router mode, not with e2e.sh --no-router");
      // With --router the router is the primary Worker, so S1-S7 above already went through it.
      const failed = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"].filter(id => results.get(id)?.status !== "PASS");
      if (failed.length) throw new Error(`not passed through the router: ${failed.join(", ")}`);
    },
  },
  {
    id: "S11", title: "node.log has none of the known failure messages; every /api socket closed cleanly",
    covers: "all",
    needs: [], timeoutMs: Session.CLOSE_TIMEOUT_MS + 10_000,
    async run() {
      const unclosed = await Session.closeAll();
      // Give celld a moment to log the sessions' ends.
      await sleep(1000);
      const abnormal = Session.all.filter(session => session.closeCode === 1006);
      const found = scanNodeLog(nodeLog.text(), abnormal.length);
      if (abnormal.length) {
        found.unshift(`${abnormal.length} /api WebSocket(s) closed with 1006: ${abnormal.map(s => s.label).join(", ")}`);
      }
      if (unclosed.length) found.unshift(`/api WebSocket(s) never closed: ${unclosed.map(s => s.label).join(", ")}`);
      if (found.length) throw new Error("\n    " + found.join("\n    "));
      return `${Session.all.length} socket(s) closed cleanly`;
    },
  },
];

const ORDER = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"];

nodeLog.start();
console.log(`smoke: ${origin} (${router ? "router" : "workshop"} primary)${quick ? ", --quick" : ""}`);
await runSteps(steps, results);
await Session.closeAll();
process.exit(summarize("smoke", results, ORDER) ? 1 : 0);
