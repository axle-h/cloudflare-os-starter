# Cloudflare OS on celld (trial)

Runs this deployment on a local [celld](https://github.com/denoland/celld) node instead of
Cloudflare. It is a test harness, not a supported deploy path: the findings live in celld's
`plans/cloudflare-os-trial.md`, and the work that follows them in `plans/cloudflare-os-fixes.md`.

Every script needs Node.js 26 (`source ~/.nvm/nvm.sh`) and a `pnpm install` in this repository,
which also installs the `cloudflare-os/` submodule (`git submodule update --init` first on a fresh
clone). `env.sh` expects the celld binary at `~/projects/celld/target/release/celld`; set `CELLD`
to use another, such as `target/lab/celld`.

## The e2e harness

`celld/e2e.sh COMMAND [--router] [--fresh] [--dev-store] [--quick]` brings everything up in one
command and keeps its state under `.celld/e2e/`:

```sh
celld/e2e.sh all --fresh   # Azurite, mock LLM, build, check, deploy, node, smoke, browser
celld/e2e.sh smoke --quick # the smoke steps again, without S12's 65 s wait
celld/e2e.sh down          # stop what e2e.sh started
```

| Command | What it does |
| --- | --- |
| `up` | Starts Azurite 3.37.0 (pinned by digest) in podman as `celld-e2e-azurite` on port 10000, creates the blob container `celld-e2e-$RUN_ID`, and starts the mock LLM on port 11434. |
| `build` | Runs `build.sh`, unless the last build is newer than every source file. |
| `check` | Generates the configs and runs `celld deploy --dry-run` for every Worker. |
| `deploy` | Deploys every Worker with `deploy.sh` to `az://celld-e2e-$RUN_ID`. If the node is running, it must adopt the deploy, or `deploy` fails. |
| `node` | Starts the node on 127.0.0.1:8790, logging to `.celld/e2e/node.log`, then checks that `GET /` returns HTML and that `ping()` round-trips over Cap'n Web at `ws://…/api`, within 60 s. On failure it prints the last 200 log lines. `--router` and `--dev-store` must match the deploy and any running node. |
| `restart` | Stops the node and starts it again, with `node`'s health check. Smoke step S9 uses it. |
| `smoke` | Runs `e2e/smoke.ts` (steps S0-S13, below) against the running node. Exits non-zero if a step failed. |
| `browser` | Runs `e2e/browser.ts` (steps B0-B5, below) in headless Chromium against the running node. Screenshots go to `.celld/e2e/shots/`. |
| `all` | `up`, `build`, `check`, `deploy`, `node`, `smoke` and `browser`. A smoke failure does not stop `browser`; `all` fails if either failed. |
| `down` | Stops the node, the mock LLM and Azurite if this script started them. The data stays: every run's blob container accumulates in `celld-e2e-azurite` until `down --fresh` removes the container, and the node's local data with it. |

- **`--router`** makes the router the primary Worker, as on Cloudflare. Without it the workshop
  is the primary and serves the frontend, because celld cannot yet return a WebSocket through a
  service binding: with `--router` the health check fails at `ping()` (trial failure 5), so `all
  --router` stops there; `smoke --router` still runs against that node.
- **`--fresh`** (with `up` or `all`) starts a new run: a new run id, so an empty blob container,
  and empty local node data.
- **`--quick`** (with `smoke` or `all`) skips smoke step S12, which waits more than 60 s.
- **`--dev-store`** runs all seven Workers under one multi-config `celld dev`, with no Azurite and
  no podman. `celld dev` keeps its state in the primary config's directory, which is the project
  root, so in `./.celld/dev` (not `.celld/e2e/`). `deploy` then only generates the configs,
  `celld dev` deploys them when it starts, and `--fresh` passes `--clean`, which clears
  `./.celld/dev`.

Every command can be run again: it skips what is already up or built, and it refuses options it
does not use. `restart`, `smoke` and `browser` need a running node, and `--router` and
`--dev-store` must match it. `E2E_PORT` moves the node, `E2E_AZURITE_PORT` moves Azurite and `MOCK_LLM_PORT` moves
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
| S0 | `GET /` returns HTML; `ping()` as a Cap'n Web HTTP batch through `POST /api` (with `--router`, through the router's service binding) |
| S1 | sign in; `amIAdmin()` is true; `getAdminApi()` returns a stub |
| S2 | `setGatekeeperMode` for every auto-provisioning gatekeeper: `optional` (the default), and `custom` to `disabled`, so S9 has a non-default mode to find |
| S3 | `subscribeToNotifications`, then dispose it; the session still answers |
| S4 | `subscribeConnectedAccounts`: `ready()` within 10 s |
| S5 | `provisionAmbientAccount("context")`: the account arrives on S4's subscriber; SKIP if the account exists from an earlier run on the bucket |
| S6 | `newGadget().newChat("hello", "scripted")`, pipelined: a chat id, the mock is called, the chat goes idle with the mock's reply in it and no error |
| S7 | `newGadgetFromBlueprint` on the first featured blueprint, then `getMetadata()` has a title |
| S8 | a scripted `executeCode` registers `env.SCHEDULER.runAt(t, self)`, `t` 60 s out; the hook is enabled (failing if that comes within 5 s of `t`); an `onSchedule` agentCallback message reaches the chat |
| S9 | `e2e.sh restart`; sign in again; S2's `custom` mode (then put back to `optional`), S5's account and S6's reply survive (each checked if its step passed) |
| S10 | with `--router` only: S1-S7 passed, all of them through the router |
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

`env.sh` sets `CELLD_FETCH_PRIVATE_ALLOW` to `127.0.0.1:$MOCK_LLM_PORT` (default 11434), so the
node may reach the mock once celld refuses private fetch targets.

## Manual setup

1. Start a bucket. celld needs S3, GCS or Azure; locally, the Azurite emulator works:

   ```sh
   podman run -d --name celld-azurite -p 10000:10000 \
     mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --loose
   python3 celld/azurite-container.py celld
   ```

2. Build the Workers: `celld/build.sh`.
3. Deploy: `celld/deploy.sh --no-router`. Without `--no-router` the router is the entry point, but
   celld cannot yet return a WebSocket through a service binding, so the `/api` session fails.
4. Run a node:

   ```sh
   . celld/env.sh && mkdir -p .celld && cd .celld && \
     "$CELLD" --bucket "$CELLD_BUCKET" --listen 127.0.0.1:8790 > node.log 2>&1 &
   ```

5. Open http://127.0.0.1:8790 and sign up as `admin` (the configured admin; the trial password
   is in `celld/env.sh`).

`generate.ts` documents each workaround it applies to the configs. It also exports them:
`celldFilter(config)` applies them to one Wrangler config, and `generateConfigs(options)` builds
every Worker's config without writing files.
