#!/usr/bin/env bash
# Generate the celld configs and deploy every Worker; the last one deployed is the fleet's primary.
# Arguments go to generate.ts. With --no-router the workshop is deployed last and serves the frontend.
set -euo pipefail
cd "$(dirname "$0")/.."
. celld/env.sh
node celld/generate.ts "$@"
workers=(error-reporter gatekeeper-context gatekeeper-scheduler gatekeeper-websearch custom-gatekeeper)
if [[ " $* " == *" --no-router "* ]]; then workers+=(router workshop-backend); else workers+=(workshop-backend router); fi
for worker in "${workers[@]}"; do
  "$CELLD" deploy "celld.$worker.jsonc" --bucket "$CELLD_BUCKET" 2>&1 | grep -E '^Error|Current Version' | sed "s/^/$worker: /"
done
internal=$(grep -o 'internal listening on [0-9.:]*' .celld/node.log 2>/dev/null | tail -1 | awk '{print $4}')
if [[ -n "$internal" ]]; then curl -s -X POST "http://$internal/reload" | head -c 300; echo; fi
