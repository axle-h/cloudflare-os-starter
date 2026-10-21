#!/usr/bin/env bash
# Build every Worker the way `cf-os deploy` does, without deploying. The frontend is built without
# VITE_CF_ACCESS_MODE, so it uses the built-in password sign-in.
set -euo pipefail
cd "$(dirname "$0")/.."
sub() { pnpm --dir cloudflare-os exec vp run -F "$1" --no-cache "${2:-build}"; }
sub @gadgets/gatekeeper-context build:app
sub @gadgets/gatekeeper-scheduler build:app
sub @gadgets/workshop-frontend
# `wrangler deploy` runs each Worker's build.command; celld does not, so run it here.
for dir in cloudflare-os/packages/gatekeeper-context cloudflare-os/packages/gatekeeper-scheduler \
  cloudflare-os/packages/gatekeeper-websearch packages/custom-gatekeeper; do
  (cd "$dir" && pnpm exec capnweb-validate build --out .wrangler/validate)
done
(cd cloudflare-os/packages/workshop-backend && pnpm run build:worker)
