#!/usr/bin/env bash
# Cloudflare OS e2e harness on celld (plan item 0.4 in celld's plans/cloudflare-os-fixes.md).
#
# Usage: celld/e2e.sh COMMAND [--no-router] [--fresh] [--dev-store] [--quick]
#
#   up       Start Azurite in podman (celld-e2e-azurite, port 10000), create the blob container
#            celld-e2e-$RUN_ID, and start the mock LLM (celld/mock-llm.ts, port 11434).
#            Takes --fresh and --dev-store.
#   build    Run celld/build.sh, unless the last build is newer than every source file.
#   check    Generate the configs and run `celld deploy --dry-run` for every Worker, which also runs
#            each Worker's build.command. Takes --no-router.
#   deploy   Deploy every Worker with celld/deploy.sh, which runs each build.command again. With
#            --dev-store, only generate the configs. Takes --no-router and --dev-store.
#   node     Start the node if it is not running, then check its health: `GET /` returns HTML and
#            `ping()` round-trips over Cap'n Web at ws://…/api, within 60 s. Takes --no-router and
#            --dev-store, which must match what was deployed and what is running.
#   restart  Stop the node and start it again, then check its health as node does. Takes --no-router
#            and --dev-store. Smoke step S9 uses it.
#   smoke    Run celld/e2e/smoke.ts, steps S0-S13, against the running node; it may restart the node
#            (S9). Takes --no-router and --dev-store, which must match the running node, and --quick,
#            which skips S12 (it waits more than 60 s).
#   browser  Run celld/e2e/browser.ts, a Chromium session through the UI, against the running node.
#            Screenshots go to .celld/e2e/shots/. Takes --no-router and --dev-store, as smoke does.
#   all      up, build, check, deploy, node, smoke and browser. Takes every option. Its deploy
#            passes --no-build, because check has just run every build.command. A smoke failure
#            does not stop browser; all fails if either failed.
#   down     Stop what this script started, and nothing else. The data stays unless --fresh is
#            given: then it also removes the celld-e2e-azurite container (every run's blob
#            container with it) and the node's local data.
#
#   --no-router  Make the workshop the primary Worker and serve the frontend from it, instead of
#                the router, as on Cloudflare. It was workaround W5 for trial failure 5, which plan
#                item 1.7 fixed; it stays for comparing the two entry points.
#   --fresh      With up or all: stop the node and start a new run, with a new RUN_ID (so a new,
#                empty blob container) and empty local node data; with --dev-store, celld dev
#                also starts with --clean.
#   --quick      With smoke or all: skip smoke step S12, for quick loops.
#   --dev-store  Run every Worker under one multi-config `celld dev`, with no Azurite and no podman.
#                celld dev keeps its state in the primary config's directory, which is the
#                project root, so in ./.celld/dev; --fresh clears it with --clean.
#
# The harness's own state lives under .celld/e2e/: the node log (node.log), the mock LLM log,
# process ids, the run id and the node's local data. E2E_PORT moves the node off 127.0.0.1:8790,
# E2E_AZURITE_PORT moves Azurite off 10000, and MOCK_LLM_PORT moves the mock LLM off 11434, for
# instance beside a trial deployment. CELLD (see celld/env.sh) chooses the celld binary.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=.celld/e2e
PORT=${E2E_PORT:-8790}
AZURITE=celld-e2e-azurite
# Azurite 3.37.0; the digest is the multi-architecture manifest list.
AZURITE_IMAGE=mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5
AZURITE_PORT=${E2E_AZURITE_PORT:-10000}
export MOCK_LLM_PORT=${MOCK_LLM_PORT:-11434}
HEALTH_TIMEOUT_S=60
NODE_STOP_TIMEOUT_S=45 # celld bounds its own shutdown at CELLD_SHUTDOWN_TOTAL_MS (40 s)
WORKERS=(error-reporter gatekeeper-context gatekeeper-scheduler gatekeeper-websearch custom-gatekeeper workshop-backend router)

log() { echo "e2e: $*" >&2; }
die() { echo "e2e: error: $*" >&2; exit 1; }

command=${1:-}
[[ -n "$command" ]] || die "usage: celld/e2e.sh up|build|check|deploy|node|restart|smoke|browser|all|down [--no-router] [--fresh] [--dev-store] [--quick]"
shift
case "$command" in
  up) allowed="--fresh --dev-store" ;;
  build) allowed="" ;;
  check) allowed="--no-router" ;;
  deploy | node | restart | browser) allowed="--no-router --dev-store" ;;
  smoke) allowed="--no-router --dev-store --quick" ;;
  all) allowed="--no-router --fresh --dev-store --quick" ;;
  down) allowed="--fresh" ;;
  *) die "unknown command $command" ;;
esac
router=true fresh=false dev_store=false quick=false
for arg in "$@"; do
  [[ " $allowed " == *" $arg "* ]] || die "$command does not take $arg${allowed:+ (it takes $allowed)}"
  case "$arg" in
    --no-router) router=false ;;
    --fresh) fresh=true ;;
    --dev-store) dev_store=true ;;
    --quick) quick=true ;;
  esac
done

mkdir -p "$STATE"
. celld/env.sh
# Exactly the mock LLM (celld plan item 1.9), whatever the shell has: the Workers reach no other
# private address.
export CELLD_FETCH_PRIVATE_ALLOW="127.0.0.1:$MOCK_LLM_PORT"
export PUBLIC_BASE_URL="http://127.0.0.1:$PORT"
# celld (object_store) and azurite-container.py both read the emulator's address from here.
export AZURITE_BLOB_STORAGE_URL="http://127.0.0.1:$AZURITE_PORT"

# --- helpers -------------------------------------------------------------------------------------

require_tools() {
  [[ -x "$CELLD" ]] || die "no celld binary at $CELLD; build it (cargo build --profile lab -p celld) and set CELLD"
  [[ -x "$CELLD_ESBUILD" ]] || die "no esbuild at '$CELLD_ESBUILD'; run pnpm install"
  command -v node > /dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 26 ? 0 : 1)' \
    || die "Node.js 26 or later must be on PATH (source ~/.nvm/nvm.sh)"
  command -v python3 > /dev/null || die "python3 must be on PATH"
  command -v curl > /dev/null || die "curl must be on PATH"
  if ! $dev_store; then command -v podman > /dev/null || die "podman must be on PATH (or use --dev-store)"; fi
}

run_id() {
  [[ -s "$STATE/run-id" ]] || date -u +%Y%m%d%H%M%S > "$STATE/run-id"
  cat "$STATE/run-id"
}

use_run_bucket() {
  export CELLD_BUCKET="az://celld-e2e-$(run_id)"
}

port_open() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

wait_port() { # PORT SECONDS WHAT
  local end=$((SECONDS + $2))
  until port_open "$1"; do
    ((SECONDS < end)) || die "$3 did not open port $1 within $2 s"
    sleep 0.5
  done
}

# A process's start time in clock ticks since boot (field 22 of /proc/PID/stat; the fields after
# the parenthesised command name start at field 3).
start_time() { sed 's/.*) //' "/proc/$1/stat" 2> /dev/null | cut -d' ' -f20; }

# Whether NAME's pid file names a live process that this script started: the pid and its start
# time, recorded at start, both match, so a reused pid is never mistaken for ours.
alive() { # NAME
  local file="$STATE/$1.pid" pid="" started=""
  [[ -f "$file" ]] || return 1
  read -r pid started < "$file" || true
  [[ -n "$pid" && -n "$started" ]] || return 1
  [[ "$(start_time "$pid")" == "$started" ]]
}

# Starts COMMAND… detached in its own process group and records it as NAME.
start_bg() { # NAME STDOUT STDERR COMMAND…
  local name=$1 out=$2 err=$3 pid
  shift 3
  if [[ "$out" == "$err" ]]; then
    setsid "$@" > "$out" 2>&1 < /dev/null &
  else
    setsid "$@" > "$out" 2> "$err" < /dev/null &
  fi
  pid=$!
  echo "$pid $(start_time "$pid")" > "$STATE/$name.pid"
}

# Stops NAME if it is ours and alive; returns 1 if it was not running. The pid file goes only once
# the process is gone, or when it names a process this script did not start.
stop_bg() { # NAME TIMEOUT_S
  local pid end
  if ! alive "$1"; then
    rm -f "$STATE/$1.pid"
    return 1
  fi
  read -r pid _ < "$STATE/$1.pid"
  kill -TERM -- "-$pid" 2> /dev/null || kill -TERM "$pid" 2> /dev/null || true
  end=$((SECONDS + $2))
  while alive "$1"; do
    if ((SECONDS >= end)); then
      log "$1 (pid $pid) ignored SIGTERM for $2 s; killing it"
      kill -KILL -- "-$pid" 2> /dev/null || kill -KILL "$pid" 2> /dev/null || true
      sleep 0.5
      alive "$1" && die "$1 (pid $pid) survived SIGKILL"
      break
    fi
    sleep 0.5
  done
  rm -f "$STATE/$1.pid"
  log "stopped $1 (pid $pid)"
}

# The mode a node runs or a deploy was made in: "node router", "dev-store workshop", and so on.
wanted_mode() { echo "$($dev_store && echo dev-store || echo node) $($router && echo router || echo workshop)"; }

node_alive() { alive node; }

stop_node() { stop_bg node "$NODE_STOP_TIMEOUT_S"; }

generate_flags() { if $router; then :; else echo --no-router; fi; }

# The `dropped …` lines generate.ts prints for every run.
without_dropped() { grep -v -E '^[a-z-]+: dropped ' || true; }

# Runs generate.ts, printing its stderr except the dropped keys.
generate() {
  local out
  out=$(node celld/generate.ts $(generate_flags) 2>&1) || { echo "$out" >&2; die "generate.ts failed"; }
  without_dropped <<< "$out" >&2
}

dump_node_log() {
  log "last 200 lines of $STATE/node.log:"
  tail -n 200 "$STATE/node.log" >&2 || true
}

# The pinned image's id, pulling the image if it is missing.
azurite_image_id() {
  podman image exists "$AZURITE_IMAGE" || podman pull -q "$AZURITE_IMAGE" > /dev/null
  podman image inspect -f '{{.Id}}' "$AZURITE_IMAGE"
}

# Refuses an existing celld-e2e-azurite whose port or image differs from what this run needs.
check_azurite_container() {
  local bound image
  bound=$(podman inspect -f '{{range (index .HostConfig.PortBindings "10000/tcp")}}{{.HostIP}}:{{.HostPort}}{{end}}' "$AZURITE")
  image=$(podman inspect -f '{{.Image}}' "$AZURITE")
  [[ "$bound" == "127.0.0.1:$AZURITE_PORT" ]] \
    || die "$AZURITE publishes port 10000 on $bound, not 127.0.0.1:$AZURITE_PORT; set E2E_AZURITE_PORT to match, or run down --fresh (it removes the container and every run's data)"
  [[ "$image" == "$(azurite_image_id)" ]] \
    || die "$AZURITE runs image $image, not $AZURITE_IMAGE; run down --fresh (it removes the container and every run's data)"
}

# Refuses to touch a running node of another mode.
require_node_mode() {
  if node_alive && [[ "$(cat "$STATE/node.mode")" != "$(wanted_mode)" ]]; then
    die "the running node is in mode '$(cat "$STATE/node.mode")', not '$(wanted_mode)'; run down first"
  fi
}

# --- commands ------------------------------------------------------------------------------------

cmd_up() {
  if $fresh; then
    stop_node || true
    rm -f "$STATE/run-id" "$STATE/deployed" "$STATE/generated" "$STATE/origin"
    rm -rf "$STATE/node-data"
    if $dev_store; then touch "$STATE/clean-pending"; fi
  fi
  local id
  id=$(run_id)
  if ! $dev_store; then
    if podman container exists "$AZURITE"; then check_azurite_container; fi
    if [[ "$(podman inspect -f '{{.State.Running}}' "$AZURITE" 2> /dev/null)" == true ]]; then
      log "Azurite ($AZURITE) is already running"
    else
      port_open "$AZURITE_PORT" && die "port $AZURITE_PORT is taken by something other than $AZURITE (see podman ps; ss -ltnp); stop it or set E2E_AZURITE_PORT"
      if podman container exists "$AZURITE"; then
        podman start "$AZURITE" > /dev/null
      else
        azurite_image_id > /dev/null
        podman run -d --name "$AZURITE" -p "127.0.0.1:$AZURITE_PORT:10000" \
          "$AZURITE_IMAGE" azurite-blob --blobHost 0.0.0.0 --loose > /dev/null
      fi
      touch "$STATE/azurite.started"
      log "started Azurite ($AZURITE) on 127.0.0.1:$AZURITE_PORT"
    fi
    wait_port "$AZURITE_PORT" 60 Azurite
    local tries=0
    until python3 celld/azurite-container.py "celld-e2e-$id" > "$STATE/azurite-container.out" 2>&1; do
      ((++tries < 10)) || { cat "$STATE/azurite-container.out" >&2; die "could not create container celld-e2e-$id"; }
      sleep 1
    done
    case "$(cat "$STATE/azurite-container.out")" in
      201) log "created blob container celld-e2e-$id" ;;
      409*) log "blob container celld-e2e-$id already exists" ;;
      *) cat "$STATE/azurite-container.out" >&2; die "unexpected answer creating celld-e2e-$id" ;;
    esac
  fi
  if alive mock-llm; then
    log "mock LLM is already running"
  else
    port_open "$MOCK_LLM_PORT" && die "port $MOCK_LLM_PORT is taken by something other than this script's mock LLM; stop it or set MOCK_LLM_PORT"
    start_bg mock-llm "$STATE/mock-llm.log" "$STATE/mock-llm.log" node celld/mock-llm.ts
    local end=$((SECONDS + 15))
    until curl -sf "http://127.0.0.1:$MOCK_LLM_PORT/v1/models" > /dev/null; do
      alive mock-llm || { cat "$STATE/mock-llm.log" >&2; die "the mock LLM exited"; }
      ((SECONDS < end)) || die "the mock LLM did not answer within 15 s"
      sleep 0.2
    done
    log "started the mock LLM on 127.0.0.1:$MOCK_LLM_PORT"
  fi
  log "up: run $id"
}

cmd_build() {
  local stamp="$STATE/build.stamp" next="$STATE/build.stamp.next" newer=""
  # The Workers' own build.command outputs (.wrangler/validate) come from celld deploy, not here.
  local outputs=(
    cloudflare-os/packages/workshop-frontend/dist/index.html
    cloudflare-os/packages/gatekeeper-context/dist-app
    cloudflare-os/packages/gatekeeper-scheduler/dist-app
  )
  if [[ -f "$stamp" ]]; then
    # Build outputs (dist, dist-app, .wrangler) are not sources, and neither is what the workshop's
    # build.command writes to src/generated, which check and deploy run after this build.
    newer=$(find cloudflare-os/packages packages celld/build.sh pnpm-lock.yaml \
      \( -name node_modules -o -name 'dist*' -o -name .wrangler -o -name '.vite*' -o -name coverage \
      -o -path cloudflare-os/packages/workshop-backend/src/generated \) -prune \
      -o -type f -newer "$stamp" -print -quit)
    local missing=false output
    for output in "${outputs[@]}"; do [[ -e "$output" ]] || missing=true; done
    if [[ -z "$newer" ]] && ! $missing; then
      log "build: up to date (nothing changed since $(date -r "$stamp" +%T))"
      return
    fi
  fi
  log "build: running celld/build.sh${newer:+ ($newer changed)}"
  # Stamped before the build starts, so a source edited during the build triggers the next one.
  touch "$next"
  celld/build.sh
  mv "$next" "$stamp"
}

cmd_check() {
  generate
  local worker out failed=0
  for worker in "${WORKERS[@]}"; do
    # A dry run bundles and never touches the bucket.
    if out=$("$CELLD" deploy "celld.$worker.jsonc" --dry-run --bucket az://celld-e2e-dry-run 2>&1); then
      log "check: $worker: $(grep -m1 'Current Version' <<< "$out" || echo ok)"
    else
      log "check: $worker FAILED:"
      echo "$out" >&2
      failed=1
    fi
  done
  ((failed == 0)) || die "check: celld deploy --dry-run refused at least one Worker"
}

# With --no-build, `celld deploy` skips each build.command: `all` passes it after check ran them.
cmd_deploy() {
  local no_build=()
  if [[ "${1:-}" == --no-build ]]; then no_build=(--no-build); fi
  require_node_mode
  if $dev_store; then
    generate
    wanted_mode > "$STATE/generated"
    if node_alive; then log "deploy: the running celld dev does not watch; run down, then node --dev-store, to load the new configs"; fi
    log "deploy: configs generated; celld dev deploys them when it starts"
    return
  fi
  port_open "$AZURITE_PORT" || die "Azurite is not running; run up first"
  use_run_bucket
  # With CELLD_NODE_LOG set, deploy.sh fails when the running node does not adopt the deploy.
  local node_log=/dev/null
  if node_alive; then node_log="$STATE/node.log"; fi
  CELLD_NODE_LOG=$node_log celld/deploy.sh $(generate_flags) "${no_build[@]}" 2> >(without_dropped >&2)
  echo "$(run_id) $(wanted_mode)" > "$STATE/deployed"
  log "deploy: deployed to $CELLD_BUCKET ($($router && echo router || echo workshop) primary)"
}

cmd_node() {
  require_node_mode
  if node_alive; then
    log "node: already running ($(cat "$STATE/origin"))"
  else
    port_open "$PORT" && die "port $PORT is taken by something other than this script's node; stop it or set E2E_PORT"
    local redo="deploy$($router || echo ' --no-router')$($dev_store && echo ' --dev-store')"
    if $dev_store; then
      [[ "$(cat "$STATE/generated" 2> /dev/null)" == "$(wanted_mode)" ]] \
        || die "the configs were not generated for '$(wanted_mode)'; run $redo first"
    else
      use_run_bucket
      [[ "$(cat "$STATE/deployed" 2> /dev/null)" == "$(run_id) $(wanted_mode)" ]] \
        || die "$CELLD_BUCKET has no '$(wanted_mode)' deploy (recorded: '$(cat "$STATE/deployed" 2> /dev/null)'); run $redo first"
    fi
    if [[ -f "$STATE/node.log" ]]; then mv "$STATE/node.log" "$STATE/node.log.prev"; fi
    if $dev_store; then
      start_dev_store
    else
      start_node
    fi
    wanted_mode > "$STATE/node.mode"
  fi
  local origin health
  origin=$(cat "$STATE/origin")
  node celld/e2e/health.ts "$origin" "$HEALTH_TIMEOUT_S" &
  health=$!
  while kill -0 "$health" 2> /dev/null; do
    if ! node_alive; then
      kill "$health" 2> /dev/null || true
      dump_node_log
      die "node: the node exited during the health check"
    fi
    sleep 0.5
  done
  if ! wait "$health"; then
    dump_node_log
    die "node: health check failed"
  fi
  log "node: healthy at $origin (log: $STATE/node.log)"
}

start_node() {
  port_open "$AZURITE_PORT" || die "Azurite is not running; run up first"
  mkdir -p "$STATE/node-data"
  CELLD_WATCH="$STATE/node-data" start_bg node "$STATE/node.log" "$STATE/node.log" \
    "$CELLD" --bucket "$CELLD_BUCKET" --listen "127.0.0.1:$PORT"
  echo "$PUBLIC_BASE_URL" > "$STATE/origin"
  log "node: started (pid $(cut -d' ' -f1 "$STATE/node.pid")) on $PUBLIC_BASE_URL with bucket $CELLD_BUCKET"
}

start_dev_store() {
  local primary=workshop-backend configs=() worker clean=() line=""
  if $router; then primary=router; fi
  configs+=(-c "celld.$primary.jsonc")
  for worker in "${WORKERS[@]}"; do [[ "$worker" == "$primary" ]] || configs+=(-c "celld.$worker.jsonc"); done
  if [[ -f "$STATE/clean-pending" ]]; then clean=(--clean); fi
  start_bg node "$STATE/dev.stdout" "$STATE/node.log" \
    "$CELLD" dev "${configs[@]}" --port "$PORT" --no-watch --logs "${clean[@]}"
  rm -f "$STATE/clean-pending"
  log "node: started celld dev (pid $(cut -d' ' -f1 "$STATE/node.pid")), primary $primary${clean:+, clean}"
  local end=$((SECONDS + 300))
  until line=$(grep -m1 '"event":"ready"' "$STATE/dev.stdout"); do
    node_alive || { dump_node_log; die "celld dev exited before it was ready"; }
    ((SECONDS < end)) || { dump_node_log; die "celld dev was not ready within 300 s"; }
    sleep 0.5
  done
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).public)' "$line" > "$STATE/origin"
  log "node: celld dev ready: $line"
}

cmd_down() {
  local stopped=false
  if stop_node; then stopped=true; fi
  if stop_bg mock-llm 10; then stopped=true; fi
  if [[ -f "$STATE/azurite.started" ]] || $fresh; then
    if [[ "$(podman inspect -f '{{.State.Running}}' "$AZURITE" 2> /dev/null)" == true ]]; then
      podman stop -t 10 "$AZURITE" > /dev/null
      log "stopped Azurite ($AZURITE)"
      stopped=true
    fi
    rm -f "$STATE/azurite.started"
  fi
  if $fresh; then
    if podman container exists "$AZURITE"; then
      podman rm "$AZURITE" > /dev/null
      log "removed $AZURITE, and every run's blob container with it"
    fi
    rm -rf "$STATE/node-data"
    rm -f "$STATE/run-id" "$STATE/deployed" "$STATE/generated" "$STATE/origin"
  elif $stopped; then
    log "the data stays: $AZURITE keeps every run's blob container until down --fresh"
  fi
  $stopped || $fresh || log "down: nothing of this script's was running"
}

# Refuses to run against no node, or a node of another mode.
require_running_node() {
  node_alive || die "no node is running; run node$($router || echo ' --no-router')$($dev_store && echo ' --dev-store') first"
  require_node_mode
}

cmd_restart() {
  require_running_node
  stop_node
  cmd_node
}

cmd_smoke() {
  require_running_node
  local flags=()
  if $router; then flags+=(--router); fi
  if $dev_store; then flags+=(--dev-store); fi
  if $quick; then flags+=(--quick); fi
  E2E_STATE="$STATE" node celld/e2e/smoke.ts "$(cat "$STATE/origin")" "${flags[@]}"
}

cmd_browser() {
  require_running_node
  E2E_STATE="$STATE" node celld/e2e/browser.ts "$(cat "$STATE/origin")"
}

case "$command" in
  up) require_tools; cmd_up ;;
  build) require_tools; cmd_build ;;
  check) require_tools; cmd_check ;;
  deploy) require_tools; cmd_deploy ;;
  node) require_tools; cmd_node ;;
  restart) require_tools; cmd_restart ;;
  smoke) require_tools; cmd_smoke ;;
  browser) require_tools; cmd_browser ;;
  all)
    require_tools
    cmd_up
    cmd_build
    cmd_check
    cmd_deploy --no-build
    cmd_node
    failed=()
    cmd_smoke || failed+=(smoke)
    cmd_browser || failed+=(browser)
    ((${#failed[@]} == 0)) || die "all: failed: ${failed[*]}"
    log "all: smoke and browser passed"
    ;;
  down) cmd_down ;;
esac
