#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COUCHCOOP_HARNESS_MODE=lobby "$repo_root/scripts/start-hosted-harness-hook.sh"
