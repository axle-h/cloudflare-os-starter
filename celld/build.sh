#!/usr/bin/env bash
# Build what `cf-os deploy` builds before `wrangler deploy`, without deploying: the gatekeepers'
# app bundles and the frontend. Each Worker's own `build.command` (capnweb-validate, and the
# workshop's browser runtime) is not run here: `celld deploy` runs it, as `wrangler deploy` does.
# The frontend is built without VITE_CF_ACCESS_MODE, so it uses the built-in password sign-in.
set -euo pipefail
cd "$(dirname "$0")/.."
sub() { pnpm --dir cloudflare-os exec vp run -F "$1" --no-cache "${2:-build}"; }
sub @gadgets/gatekeeper-context build:app
sub @gadgets/gatekeeper-scheduler build:app
sub @gadgets/workshop-frontend
