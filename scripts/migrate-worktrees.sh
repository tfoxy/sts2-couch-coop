#!/usr/bin/env bash
# Dry-run migration of existing CouchCoop worktrees into .worktrees; pass --apply to move them.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
exec python3 "$repo_root/scripts/worktree_admin.py" migrate "$@"
