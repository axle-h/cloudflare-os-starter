# Cloudflare OS on celld (trial)

Runs this deployment on a local [celld](https://github.com/denoland/celld) node instead of
Cloudflare. It is a test harness, not a supported deploy path: the findings live in celld's
`plans/cloudflare-os-trial.md`, and the work that follows them in `plans/cloudflare-os-fixes.md`.

Every script needs Node.js 26 (`source ~/.nvm/nvm.sh`) and a `pnpm install` in this repository,
which also installs the `cloudflare-os/` submodule (`git submodule update --init` first on a fresh
clone). `env.sh` expects the celld binary at `~/projects/celld/target/release/celld`; set `CELLD`
to use another, such as `target/lab/celld`.

## The e2e harness

`celld/e2e.sh COMMAND [--router] [--fresh] [--dev-store]` brings everything up in one command and
keeps its state under `.celld/e2e/`:

```sh
celld/e2e.sh all --fresh   # Azurite, mock LLM, build, check, deploy, node, health check
celld/e2e.sh down          # stop what e2e.sh started
```

| Command | What it does |
| --- | --- |
| `up` | Starts Azurite 3.37.0 (pinned by digest) in podman as `celld-e2e-azurite` on port 10000, creates the blob container `celld-e2e-$RUN_ID`, and starts the mock LLM on port 11434. |
| `build` | Runs `build.sh`, unless the last build is newer than every source file. |
| `check` | Generates the configs and runs `celld deploy --dry-run` for every Worker. |
| `deploy` | Deploys every Worker with `deploy.sh` to `az://celld-e2e-$RUN_ID`. If the node is running, it must adopt the deploy, or `deploy` fails. |
| `node` | Starts the node on 127.0.0.1:8790, logging to `.celld/e2e/node.log`, then checks that `GET /` returns HTML and that `ping()` round-trips over Cap'n Web at `ws://…/api`, within 60 s. On failure it prints the last 200 log lines. `--router` and `--dev-store` must match the deploy and any running node. |
| `smoke`, `browser` | Not implemented yet. |
| `all` | `up`, `build`, `check`, `deploy` and `node`. |
| `down` | Stops the node, the mock LLM and Azurite if this script started them. The data stays: every run's blob container accumulates in `celld-e2e-azurite` until `down --fresh` removes the container, and the node's local data with it. |

- **`--router`** makes the router the primary Worker, as on Cloudflare. Without it the workshop
  is the primary and serves the frontend, because celld cannot yet return a WebSocket through a
  service binding: with `--router` the health check fails at `ping()` (trial failure 5).
- **`--fresh`** (with `up` or `all`) starts a new run: a new run id, so an empty blob container,
  and empty local node data.
- **`--dev-store`** runs all seven Workers under one multi-config `celld dev`, with no Azurite and
  no podman. `celld dev` keeps its state in the primary config's directory, which is the project
  root, so in `./.celld/dev` (not `.celld/e2e/`). `deploy` then only generates the configs,
  `celld dev` deploys them when it starts, and `--fresh` passes `--clean`, which clears
  `./.celld/dev`.

Every command can be run again: it skips what is already up or built, and it refuses options it
does not use. `E2E_PORT` moves the node, `E2E_AZURITE_PORT` moves Azurite and `MOCK_LLM_PORT` moves
the mock LLM, for instance beside the manual setup below. An existing `celld-e2e-azurite` keeps the
port it was created with; `up` refuses one on another port.

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
