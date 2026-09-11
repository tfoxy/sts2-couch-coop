#!/usr/bin/env bash
# Publish the public-origin bootstrap to Cloudflare Pages.
#
# WHAT IS BEING DEPLOYED, and why it is so small: everything under frontend/pages-dist is a ~5KB bootstrap
# plus icons. No application code, no game assets, no protocol knowledge. The client itself is served by
# the mod on the player's own PC and fetched over the LAN, which is what makes version skew impossible —
# see docs/agents/local-network-access.md.
#
# So this is very nearly a deploy-ONCE artifact. It needs republishing when the bootstrap's own UX or the
# boot contract changes, not on every release of the mod.
#
# FIRST TIME (needs a Cloudflare account):
#   npx wrangler login                       # or export CLOUDFLARE_API_TOKEN=...
#   npx wrangler pages project create sts2-couch --production-branch main
#   bash scripts/deploy-pages.sh
#
# The project name has to match the origin baked into the mod's QR (CouchCoopWebOrigin.DefaultOrigin,
# currently https://sts2-couch.pages.dev). If you deploy somewhere else, point the mod at it with
# COUCHCOOP_WEB_ORIGIN rather than editing the default — that is exactly what the env var is for, and it
# is how the tunnel rehearsal below works with no rebuild.
#
# REHEARSING WITHOUT DEPLOYING AT ALL:
#   cd frontend && npm run build:pages && npm run preview:pages &
#   cloudflared tunnel --url http://127.0.0.1:4173          # -> https://<random>.trycloudflare.com
#   COUCHCOOP_WEB_ORIGIN=https://<random>.trycloudflare.com  <launch the game>
# That gives a genuinely public HTTPS origin, which is all the Local Network Access permission requires.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${COUCHCOOP_PAGES_PROJECT:-sts2-couch}"
OUT_DIR="$REPO_ROOT/frontend/pages-dist"

cd "$REPO_ROOT/frontend"

echo "==> building the bootstrap"
npm run build:pages

# A deploy of the wrong directory is silently plausible — Pages will happily publish an empty folder, and
# the failure only shows up as a blank page on someone's phone. Check the two files that must exist.
for required in index.html boot.js; do
  if [[ ! -f "$OUT_DIR/$required" ]]; then
    echo "ERROR: $OUT_DIR/$required is missing — refusing to deploy an incomplete bootstrap." >&2
    exit 1
  fi
done

echo "==> publishing $OUT_DIR to Cloudflare Pages project '$PROJECT'"
npx wrangler pages deploy "$OUT_DIR" --project-name "$PROJECT" --env-file .env "$@"
