#!/usr/bin/env bash
# Upstream's integration suites on celld (plan item 0.5 in celld's plans/cloudflare-os-fixes.md).
#
# Usage: celld/integration.sh [--update] [--workerd] [--no-prebuild] [SUITE...]
#
#   SUITE          A suite of cloudflare-os/packages/integration-tests/__tests__, such as
#                  workshop-lifecycle. Without any, every suite celld/integration/status.json lists
#                  as passing or pending.
#   --update       Record each pending suite that passed as passing in status.json.
#   --workerd      Run the same suites on upstream's harness (workerd), as the reference.
#   --no-prebuild  Skip building the validated Worker trees the suites boot from (the Workshop's,
#                  gatekeeper-context's and the fixture gatekeeper's), when they are current.
#
# Each suite file starts its own multi-config `celld dev` on a free port (`--port 0`) and its own mock
# upstream on another, both on 127.0.0.1, so nothing here uses a fixed port or touches a node the
# trial or e2e.sh runs. CELLD_INTEGRATION_JOBS (default 1) runs that many suite files at once.
# State, the generated configs and each node's dev.log stay under .celld/integration/ until the next
# run. The run fails if a suite listed as passing does not pass, or if the adapter's own checks
# (celld/integration/adapter.test.ts) fail. CELLD (see celld/env.sh) chooses the celld binary.
set -euo pipefail
cd "$(dirname "$0")/.."

log() { echo "integration: $*" >&2; }
die() { echo "integration: error: $*" >&2; exit 2; }

prebuild=true
run_args=()
for arg in "$@"; do
  case "$arg" in
    --no-prebuild) prebuild=false ;;
    --update | --workerd) run_args+=("$arg") ;;
    --*) die "unknown option $arg (options: --update, --workerd, --no-prebuild)" ;;
    *) run_args+=("$arg") ;;
  esac
done

. celld/env.sh
[[ -x "$CELLD" ]] || die "no celld binary at $CELLD (set CELLD)"
[[ -x "$CELLD_ESBUILD" ]] || die "no esbuild at $CELLD_ESBUILD (run pnpm install, or set CELLD_ESBUILD)"
# The mock upstream's address is only known once it listens; the harness sets
# CELLD_FETCH_PRIVATE_ALLOW to exactly that for each node, so none is inherited.
unset CELLD_FETCH_PRIVATE_ALLOW

if $prebuild; then
  log "building the validated Worker trees (upstream's build:test-gatekeeper)"
  pnpm --dir cloudflare-os exec vp run -F @gadgets/integration-tests build:test-gatekeeper >&2
fi
exec node celld/integration/run.ts "${run_args[@]}"
