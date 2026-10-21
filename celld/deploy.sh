#!/usr/bin/env bash
# Generate the celld configs and deploy every Worker; the last one deployed is the fleet's primary.
# Arguments go to generate.ts. With --no-router the workshop is deployed last and serves the frontend.
#
# A running node adopts a deploy on its next poll; deploy.sh asks the node whose log is
# .celld/node.log to reload at once, and reports a failed reload without failing. Setting
# CELLD_NODE_LOG names that log instead, and makes a failed reload fail the deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
. celld/env.sh
node celld/generate.ts "$@"
workers=(error-reporter gatekeeper-context gatekeeper-scheduler gatekeeper-websearch custom-gatekeeper)
if [[ " $* " == *" --no-router "* ]]; then workers+=(router workshop-backend); else workers+=(workshop-backend router); fi
for worker in "${workers[@]}"; do
  if ! out=$("$CELLD" deploy "celld.$worker.jsonc" --bucket "$CELLD_BUCKET" 2>&1); then
    echo "$out" | sed "s/^/$worker: /" >&2
    echo "deploy.sh: celld deploy failed for $worker" >&2
    exit 1
  fi
  echo "$worker: $(grep -m1 'Current Version' <<< "$out" || echo deployed)"
done
strict=${CELLD_NODE_LOG:+1}
node_log=${CELLD_NODE_LOG:-.celld/node.log}
internal=$(grep -o 'internal listening on [0-9.:]*' "$node_log" 2> /dev/null | tail -1 | awk '{print $4}' || true)
[[ -n "$internal" ]] || exit 0
if ! reply=$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST "http://$internal/reload" 2>&1); then
  reply="no node answered at $internal: $reply"$'\n'000
fi
status=${reply##*$'\n'}
body=${reply%$'\n'*}
echo "reload: $status ${body:0:300}"
if [[ "$status" != 2?? || "$body" != *'"ok":true'* ]]; then
  if [[ -n "$strict" ]]; then
    echo "deploy.sh: the node at $internal did not adopt the deploy" >&2
    exit 1
  fi
  echo "deploy.sh: the reload failed; a running node adopts the deploy on its next poll" >&2
fi
