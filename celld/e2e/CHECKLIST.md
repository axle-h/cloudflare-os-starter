# Manual checklist

What `smoke.ts` and `browser.ts` don't check, by phase of celld's `plans/cloudflare-os-fixes.md`.
Each line is a plan item's E2E/manual bullet; the item is in brackets. Run `celld/e2e.sh all --fresh`
first, then open the node's origin (`.celld/e2e/origin`) in a browser, signed in as `admin`.

## Phase 1: loud gaps and small fixes

- [ ] [1.3] Without W4 in `generate.ts`, a fresh bucket deploys; sign-up, admin settings and the
      user DO work.
- [ ] [1.4] An error report from the workshop carries the `service` and `environment` props.
- [ ] [1.6] `generate.ts --keep-unsupported`, minus `ai`/`browser`, deploys.
- [ ] [1.6] `build.sh` has no capnweb-validate loop.
- [ ] [1.6] Signing in as admin opens `/admin`, with `ADMINS` a real array.
- [ ] [1.7] Router mode (`all --router`): the UI loads past "Can't reach the server", and DevTools
      shows the `/api` 101 with `Upgrade`.
- [ ] [1.7] No "dropped a frame" lines in `.celld/e2e/node.log`; smoke S10 passes.
- [ ] [1.7] `--no-router` is gone from the README.
- [ ] [1.8] Smoke S7 gets past the pack read; "Create Gadget" no longer shows "Invalid reader
      mode".
- [ ] [1.9] The mock LLM works with `CELLD_FETCH_PRIVATE_ALLOW` from `env.sh`.
- [ ] [1.9] Asking the agent to fetch `http://127.0.0.1:<internal port>/state` is refused.

## Phase 2: capability tokens and storage

- [ ] Smoke S2 and S5 pass.
- [ ] Onboarding "turn on" for Context, Scheduler, Web Search and Custom shows no error toast.
- [ ] Those accounts survive a node restart (smoke S9, first half).
- [ ] [2.4] With two OAuth gatekeepers deployed (say GitHub and Linear, no credentials), the node
      starts and both appear on the Gatekeepers page.

## Phase 3: cross-isolate RPC

- [ ] Smoke S1, S3, S4 and S6 pass; S11 has no "cannot cross isolate".
- [ ] Sign in: no notification or account subscription errors in the console.
- [ ] Start a conversation: the mock's reply appears.
- [ ] Close the tab: `node.log` shows the subscriber disposed.
- [ ] [1.2] A chat turn completes, and the OTLP collector shows `invoke_agent`, `chat` and
      `execute_tool` spans.
- [ ] [1.11] Smoke S13 passes.

## Phase 4: facets from another script's class

- [ ] Start a conversation: the built-in gatekeepers mount (no "capsule" errors in `node.log`),
      and the workspace's Gatekeepers panel lists them.
- [ ] A scripted context search works; a scripted web search fails cleanly (it needs the Phase 9
      AI shim).

## Phase 5: `ctx.restore` and persistent stubs

- [ ] Smoke S7, S8 and S9 pass.
- [ ] A gadget created from a blueprint opens and lists its files, and opens again after a node
      restart.
- [ ] Have the scripted model schedule a task, restart the node before it fires, then see it fire
      in the chat.

## Phase 6: Dynamic Worker tails

- [ ] A scripted code-mode tool call shows its console output in the chat, not the timeout.
- [ ] A gadget's console lines appear in the gadget log.

## Phase 7: streams over RPC

- [ ] [7.1] A gadget export downloads.
- [ ] [7.1] A context collection backed by git refreshes.

## Phase 8: cross-node capabilities

- [ ] Two nodes on one bucket, the browser on node A: open workspaces until `/state` shows an
      Overseer owned by node B, then chat in it.
- [ ] Kill node B: the client reconnects and recovers.

## Phase 9: follow-ups

- [ ] [AI shim] The agent fetches `https://example.com` and gets Markdown; web search returns
      results.
