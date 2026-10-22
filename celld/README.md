# Cloudflare OS on celld (trial)

Runs this deployment on a local [celld](https://github.com/denoland/celld) node instead of
Cloudflare. It is a test harness, not a supported deploy path: the findings live in celld's
`plans/cloudflare-os-trial.md`, and the work that follows them in `plans/cloudflare-os-fixes.md`.

Every script needs Node.js 26 (`source ~/.nvm/nvm.sh`) and a `pnpm install` in this repository,
which also installs the `cloudflare-os/` submodule (`git submodule update --init` first on a fresh
clone). `env.sh` expects the celld binary at `~/projects/celld/target/release/celld`; set `CELLD`
to use another, such as `target/lab/celld`.

## The e2e harness

`celld/e2e.sh COMMAND [--fresh] [--dev-store] [--quick]` brings everything up in one
command and keeps its state under `.celld/e2e/`:

```sh
celld/e2e.sh all --fresh   # Azurite, mock LLM, build, check, deploy, node, smoke, browser
celld/e2e.sh smoke --quick # the smoke steps again, without S12's 65 s wait
celld/e2e.sh down          # stop what e2e.sh started
```

| Command | What it does |
| --- | --- |
| `up` | Starts Azurite 3.37.0 (pinned by digest) in podman as `celld-e2e-azurite` on port 10000, creates the blob container `celld-e2e-$RUN_ID`, and starts the mock LLM on port 11434. |
| `build` | Runs `build.sh` (the gatekeepers' app bundles and the frontend), unless the last build is newer than every source file. |
| `check` | Generates the configs and runs `celld deploy --dry-run` for every Worker, which runs each Worker's `build.command` too. |
| `deploy` | Deploys every Worker with `deploy.sh` to `az://celld-e2e-$RUN_ID`, running each `build.command` again; `all` passes `--no-build` instead, right after `check`. If the node is running, it must adopt the deploy, or `deploy` fails. |
| `node` | Starts the node on 127.0.0.1:8790, logging to `.celld/e2e/node.log`, then checks that `GET /` returns HTML and that `ping()` round-trips over Cap'n Web at `ws://…/api`, within 60 s. On failure it prints the last 200 log lines. `--dev-store` must match the deploy and any running node. |
| `restart` | Stops the node and starts it again, with `node`'s health check. Smoke step S9 uses it. |
| `smoke` | Runs `e2e/smoke.ts` (steps S0-S13, below) against the running node. Exits non-zero if a step failed. |
| `browser` | Runs `e2e/browser.ts` (steps B0-B5, below) in headless Chromium against the running node. Screenshots go to `.celld/e2e/shots/`. |
| `all` | `up`, `build`, `check`, `deploy`, `node`, `smoke` and `browser`. A smoke failure does not stop `browser`; `all` fails if either failed. |
| `down` | Stops the node, the mock LLM and Azurite if this script started them. The data stays: every run's blob container accumulates in `celld-e2e-azurite` until `down --fresh` removes the container, and the node's local data with it. |

- The router is the primary Worker, as on Cloudflare: it serves the frontend and proxies `/api`,
  WebSocket included, to the workshop over a service binding.
- **`--fresh`** (with `up` or `all`) starts a new run: a new run id, so an empty blob container,
  and empty local node data.
- **`--quick`** (with `smoke` or `all`) skips smoke step S12, which waits more than 60 s.
- **`--dev-store`** runs all seven Workers under one multi-config `celld dev`, with no Azurite and
  no podman. `celld dev` keeps its state in the primary config's directory, which is the project
  root, so in `./.celld/dev` (not `.celld/e2e/`). `deploy` then only generates the configs,
  `celld dev` deploys them when it starts, and `--fresh` passes `--clean`, which clears
  `./.celld/dev`.

Every command can be run again: it skips what is already up or built, and it refuses options it
does not use. `restart`, `smoke` and `browser` need a running node, and `--dev-store` must match
it. `E2E_PORT` moves the node, `E2E_AZURITE_PORT` moves Azurite and `MOCK_LLM_PORT` moves
the mock LLM, for instance beside the manual setup below. An existing `celld-e2e-azurite` keeps the
port it was created with; `up` refuses one on another port.

### Smoke steps

`e2e/smoke.ts` signs in as the trial admin over Cap'n Web, as the browser does: argon2id from
`hash-wasm` with salt `SERVICE_SALT` + username, `createAccount` (or `login` once the account
exists), then `authenticate`. It adds the mock LLM as the model `scripted`. Each step prints PASS,
FAIL or SKIP and what it covers, a trial failure (celld's `plans/cloudflare-os-trial.md`) or a plan
item; a FAIL prints the error. A step whose prerequisite did not pass is skipped, with the reason. Each
step has a timeout: the step then fails, and its body stops at its next wait (S9 kills the restart
it started).

| Step | What it does |
| --- | --- |
| S0 | `GET /` returns HTML; `ping()` as a Cap'n Web HTTP batch through `POST /api` (through the router's service binding) |
| S1 | sign in; `amIAdmin()` is true; `getAdminApi()` returns a stub |
| S2 | `setGatekeeperMode` for every auto-provisioning gatekeeper: `optional` (the default), and `custom` to `disabled`, so S9 has a non-default mode to find |
| S3 | `subscribeToNotifications`, then dispose it; the session still answers |
| S4 | `subscribeConnectedAccounts`: `ready()` within 10 s |
| S5 | `provisionAmbientAccount("context")`: the account arrives on S4's subscriber; SKIP if the account exists from an earlier run on the bucket |
| S6 | `newGadget().newChat("hello", "scripted")`, pipelined: a chat id, the mock is called, the chat goes idle with the mock's reply in it and no error |
| S7 | `newGadgetFromBlueprint` on the first featured blueprint, then `getMetadata()` has a title |
| S8 | a scripted `executeCode` registers `env.SCHEDULER.runAt(t, self)`, `t` 60 s out; the hook is enabled (failing if that comes within 5 s of `t`); an `onSchedule` agentCallback message reaches the chat |
| S9 | `e2e.sh restart`; sign in again; S2's `custom` mode (then put back to `optional`), S5's account and S6's reply survive (each checked if its step passed) |
| S10 | S1-S7 passed, all of them through the router |
| S11 | every smoke `/api` WebSocket closed, none with 1006, and the run's `node.log` (both sides of S9's restart) has none of the known failure messages; "dropped a frame for a closed WebSocket" counts only if a socket closed with 1006, since celld logs it on every clean disconnect, and for the whole run, since the log's `ws_id` cannot be tied to a client socket |
| S12 | two sessions open S6's workspace; after 65 s, a `setTitle` in one reaches the other's metadata subscription. The PASS line says how many isolates retired meanwhile; celld does not log which isolate serves a session, so it cannot confirm the sessions' own isolate retired |
| S13 | a scripted `executeCode` calls `env.GADGET.rpc.getDocument()` in a Workspace Docs workspace |

They run in the order S0-S8, S13, S12, S9, S10, S11: S9's restart ends every session, and S11
scans the log of the whole run. S6, S8 and S13 script the mock through its control API.

### Browser steps

`e2e/browser.ts` uses `playwright-core` 1.64 from the submodule's install and the Chromium it
expects in `~/.cache/ms-playwright/`; if that is missing, it prints the install command
(`node cloudflare-os/node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/cli.js
install chromium`). B0 makes sure of the account and the model over the API; then B1 logs in, B2
waits for the home page (finishing onboarding on a first visit, with Web Search left off), B3 sends
"hello" and waits for the mock's reply, B4 turns Web Search on from the Gatekeepers page (a SKIP
only if it is already under Connected), B5 creates a gadget from the first featured blueprint, and
B6 scans `node.log` as S11 does. A step fails on its own error, on a console
error or uncaught page error (except upstream's `useAuthenticatedApi must be used within an
AuthProvider` and `Flagship binding missing`), and on an `/api` WebSocket close with code 1006.
A step that failed only on console errors still lets the steps after it run.

`e2e/CHECKLIST.md` lists the manual checks, by phase of the plan.

### The mock LLM

`node celld/mock-llm.ts` is an OpenAI-compatible model on 127.0.0.1:11434 (`MOCK_LLM_PORT`
overrides the port). Add it in the app as an "Other Ollama…" provider at `http://127.0.0.1:11434`,
with model `scripted`.

- **Model API:** `GET /api/tags`, `GET /v1/models`, and `POST /v1/chat/completions`, both
  streamed (SSE) and not.
- **Scripting:** `POST /__script` appends steps to a queue, each `{"text": …}`,
  `{"toolCall": {"id", "name", "arguments"}}` or `{"error": message | {"status", "message"}}`.
  Each agent request takes the next step, and answers `{"text": "ok"}` when the queue is empty.
  Title and binding-name prompts get fixed answers from upstream's
  `integration-tests/src/mock-model.ts` and leave the queue alone.
- **Inspection:** `GET /__requests` lists the requests received, up to the last 1000;
  `POST /__reset` clears the requests and the queue.
- **Errors**, scripted or not, are OpenAI error bodies: `{"error": {"message", "type"}}`.
- **Self-test:** `node celld/mock-llm.ts --self-test` runs every endpoint on a free port.

celld refuses Worker fetches to private addresses (plan item 1.9), so the node needs
`CELLD_FETCH_PRIVATE_ALLOW` to reach the mock. `env.sh` sets it to `127.0.0.1:$MOCK_LLM_PORT`
(default 11434) unless the shell already has it; `e2e.sh` always sets exactly that entry.

## Upstream's integration suites

`celld/integration.sh` runs upstream's own end-to-end suites
(`cloudflare-os/packages/integration-tests/__tests__`) on celld, unchanged:

```sh
celld/integration.sh                     # every suite status.json lists as passing or pending
celld/integration.sh workshop-lifecycle  # one suite
celld/integration.sh --update            # record pending suites that now pass
celld/integration.sh --workerd           # the same suites on upstream's harness, as the reference
```

It first builds the validated Worker trees the suites boot from (upstream's `build:test-gatekeeper`;
`--no-prebuild` skips that), then runs vitest with `integration/vitest.config.ts`. With
`CFOS_RUNTIME=celld`, which the runner sets, the suites' `../src/harness.js` and
`../src/network-interceptor.js` resolve to this directory's `integration/harness.ts` and
`integration/network-interceptor.ts`:

- **The harness.** `startCelldHarness()` (also exported as upstream's `startHarness` and
  `startTestGatekeeperHarness`) returns upstream's `Harness`. It builds the configs as upstream's
  harness does, with the suite's patches, passes each through `generate.ts`'s `celldFilter`, and
  runs them all under one multi-config `celld dev --port 0 --no-watch --no-build`. The primary
  Worker is a generated `test-front`: it service-binds every Worker, forwards `/__worker/<name>/…`
  to that Worker (`fetchWorker`), and passes everything else, the `/api` WebSocket included, to the
  Workshop. `redeployWorkshop()` restarts `celld dev` on the same port and state with the new
  Workshop config. `server.close()`, `listen()`, `fetch()` and `getWorker(name).fetch()` work;
  the rest of wrangler's `TestHarness` throws, naming the method.
- **The network.** Every Worker's main module is wrapped so `integration/upstream-shim.js` runs
  first: it sends the Worker's global `fetch()` to `mock-upstream.ts`, a Node server in the test
  process, which hands each request, with the URL the Worker asked for, to the suite's
  `NetworkInterceptor` handlers (`scriptedChatCompletions`, `github-fake.ts` and the rest). So the
  model provider the suites configure, `api.cloudflare.com`, is answered there, as is anything
  else. As under wrangler's harness, a request no handler answers is recorded for
  `getUnmockedCalls()` and the Worker gets a 500, as does a request whose handler throws; loopback
  requests and those the interceptor's `allow` accepts go to the real address. A redirect comes
  back through the mock, so it can only lead to a URL the handlers answer (the suites' fakes
  redirect only within themselves); with `redirect: "manual"` the Worker sees the handler's own
  `Location`. `response.url` is the URL the Worker asked for. Each node gets
  `CELLD_FETCH_PRIVATE_ALLOW` set to exactly the mock's `127.0.0.1:<port>`.
- **What it bypasses.** The suites' outbound requests never take celld's real outbound path: no
  TLS, no DNS, no proxy settings, and none of plan item 1.9's egress policy, which sees only
  requests to the mock's loopback address. Those are tested by celld's own conformance cases,
  not here.
- **Workarounds.** Besides `celldFilter`'s, the harness uses a KV binding's `preview_id` as its
  `id` when it has none (`celld dev` requires `id`; `wrangler dev` uses `preview_id`), and drops
  the fixture gatekeeper's `WORKSHOP_OVERSEER`, a Durable Object binding to another script's
  class (`script_name`), which celld refuses. Each prints a line on stderr.

`integration/status.json` is the record:

- `passing` lists the suites that pass on celld, and only grows. `--update` adds a pending (or
  unlisted) suite that passed, never an excluded one.
- `pending` lists the runnable suites that do not pass yet, each as `"<text of its first error> ->
  <the trial failure or plan item behind it>"`. Every one passes on `--workerd`. The runner warns
  when a suite's first error no longer contains the recorded text.
- `excluded` lists the rest, with the reason.

The run fails when a passing suite fails: it runs that suite once more and calls it a REGRESSION,
or FLAKY if the second run passed. It also fails on an error no test owned, on a suite with no
result, when vitest fails for anything but a pending, excluded or unlisted suite failing, and when
the adapter's own checks fail. Those, `integration/adapter.test.ts`, run first against a probe
Worker (`integration/fixtures/probe/`). They check `fetchWorker`; model SSE streaming; a
handler's Content-Length; a followed redirect, and a manual one's `Location` and URL; aborts; the
500s; and that `redeployWorkshop` keeps the URL and storage and applies the new config. Two
`it.fails` cases pin known celld gaps (plan item 1.20's `response.url` after a redirect, and
`clone()` of a fetched response), and fail once celld fixes them.

On Ctrl-C (or SIGTERM, SIGHUP), each test process kills its nodes, and the runner then kills any
process still running in a harness directory before it exits.

Each suite file starts its own node and mock upstream, both on free ports of 127.0.0.1, so the
runner uses no fixed port and can run beside the trial node or `e2e.sh`.
`CELLD_INTEGRATION_JOBS=3` runs three suite files at once (the default is one). Every harness keeps
its generated configs, the node's state and its `dev.log` under
`.celld/integration/<suite>-<random>/` until the next run.

## Manual setup

1. Start a bucket. celld needs S3, GCS or Azure; locally, the Azurite emulator works:

   ```sh
   podman run -d --name celld-azurite -p 10000:10000 \
     mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --loose
   python3 celld/azurite-container.py celld
   ```

2. Build the frontend and the gatekeepers' app bundles: `celld/build.sh`. Each Worker's own
   `build.command` (capnweb-validate, and the workshop's browser runtime) runs in the next step:
   `celld deploy` runs it, as `wrangler deploy` does.
3. Deploy: `celld/deploy.sh`. The router is the entry point, as on Cloudflare. `--no-build` skips
   every `build.command`, when they have just run.
4. Run a node:

   ```sh
   . celld/env.sh && mkdir -p .celld && cd .celld && \
     "$CELLD" --bucket "$CELLD_BUCKET" --listen 127.0.0.1:8790 > node.log 2>&1 &
   ```

5. Open http://127.0.0.1:8790 and sign up as `admin` (the configured admin; the trial password
   is in `celld/env.sh`).

`generate.ts` writes each Worker's Wrangler config as upstream generates it, with its package paths
(`main`, `assets.directory`, `build.cwd`, `build.watch_dir`) rebased onto the project root, plus the
bindings `cf-os deploy` adds. One workaround is left: celld refuses the `ai`
and `browser` bindings, so they are dropped; `--keep-unsupported` keeps them, to see `celld deploy`
refuse them. `ADMINS` is a JSON var, an array, as on Cloudflare. The module exports
`celldFilter(config)`, which applies the workaround to one Wrangler config, and
`generateConfigs(options)`, which builds every Worker's config without writing files.
