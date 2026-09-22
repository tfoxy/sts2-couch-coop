#!/usr/bin/env bash
# Self-test for scripts/claude-guard-bash.sh.
#
# Two-sided on purpose. A guard that blocks a documented workflow is worse than no guard, so the
# MUST-ALLOW half is not a formality: it replays every shell line found in the fenced blocks of
# docs/agents/*.md and docs/mirror-combat-bench.md and fails if the guard denies one that is not
# on the expected-deny list below (the docs quote the footguns too, to say don't do them).
#
# Every case runs twice, once per HARNESS: the Claude Code envelope, and the Codex CLI envelope
# (extra fields, no $CLAUDE_PROJECT_DIR, and a cwd one level down inside the repo, because Codex
# hooks run in the session cwd rather than at the repo root). The same file is registered with both
# CLIs, so a verdict that differs between them is a bug.
#
# Runs correctly from the main checkout AND from a linked worktree: cases that must not trip the
# worktree rule are pinned to the main checkout, and the worktree cases to a real linked worktree.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
GUARD="$REPO/scripts/claude-guard-bash.sh"
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

pass=0; fail=0

# Echoes deny | warn | allow for a command, from a given cwd, under a given harness.
verdict() { # verdict <cmd> [cwd] [claude|codex]
  local cmd="$1" cwd="${2:-$MAIN}" harness="${3:-claude}" out
  if [ "$harness" = codex ]; then
    # Codex runs the hook in the session cwd, which is routinely a subdirectory.
    if [ -d "$cwd/frontend" ]; then cwd="$cwd/frontend"; fi
    out="$(jq -n --arg c "$cmd" --arg d "$cwd" \
            '{hook_event_name:"PreToolUse",tool_name:"Bash",cwd:$d,
              session_id:"0195f0de-0000-7000-8000-000000000000",
              turn_id:"turn_1",transcript_path:($d+"/.codex/transcript.jsonl"),
              permission_mode:"default",tool_use_id:"call_1",
              tool_input:{command:$c}}' \
          | env -u COUCHCOOP_GAME_MODS_DIR -u CLAUDE_PROJECT_DIR bash "$GUARD")"
  else
    out="$(jq -n --arg c "$cmd" --arg d "$cwd" \
            '{hook_event_name:"PreToolUse",tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' \
          | env -u COUCHCOOP_GAME_MODS_DIR bash "$GUARD")"
  fi
  if   printf '%s' "$out" | grep -q '"permissionDecision":[[:space:]]*"deny"'; then echo deny
  elif printf '%s' "$out" | grep -q 'additionalContext'; then echo warn
  else echo allow; fi
}

expect() { # expect <want> <cmd> [cwd]  — asserted under BOTH harnesses
  local want="$1" cmd="$2" cwd="${3:-$MAIN}" got harness
  for harness in claude codex; do
    got="$(verdict "$cmd" "$cwd" "$harness")"
    if [ "$got" = "$want" ]; then
      pass=$((pass+1))
    else
      fail=$((fail+1))
      printf 'FAIL  [%s] want=%-5s got=%-5s  %s\n' "$harness" "$want" "$got" "$cmd" >&2
    fi
  done
}

# A genuinely LINKED worktree — not the main checkout, which `git worktree list` prints first.
if [ "$REPO" != "$MAIN" ]; then
  WORKTREE="$REPO"
else
  WORKTREE="$(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep -v "^$MAIN$" | head -1)"
fi

echo "== must block =="
expect deny 'cd frontend && npm run build'
expect deny 'npm run build'
expect deny 'cd frontend && npx vite build'
expect deny 'pnpm run build'
expect deny 'dotnet test tests/CouchCoop.Mod.Tests'
expect deny 'dotnet test'
expect deny 'sts2 game close'
expect deny 'sts2 --json game close'
expect deny "pkill -f COUCHCOOP_HEADLESS_CLIENT"
expect deny "pkill -9 -f sts2-couch-coop/frontend"
expect deny 'xvfb-run -a scripts/run-gpu.sh node scripts/bench-mirror-replay.mjs'
expect deny 'scripts/run-gpu.sh pnpm test:webgpu-composite'
expect deny 'Xvfb :68 -screen 0 1920x1080x24'
expect deny 'env -u WAYLAND_DISPLAY /usr/bin/Xvfb :68'
expect deny 'xvfb-run -a sts2 --instance qa game launch'
expect deny 'xvfb-run -a /tmp/gameroot/SlayTheSpire2'
expect deny 'scripts/run-gpu.sh godot --path godot-client --shot /tmp/shot.png'
expect deny 'scripts/run-gpu.sh /opt/Godot_v4.5-mono --path godot-client'
if [ -n "$WORKTREE" ]; then
  expect deny 'dotnet build CouchCoop.sln' "$WORKTREE"
  # The rule has to fire from a SUBDIRECTORY of the worktree too — that is where a Codex hook runs.
  expect deny 'dotnet build CouchCoop.sln' "$WORKTREE/frontend"
  expect deny 'dotnet run --project tests/CouchCoop.Mod.Tests' "$WORKTREE/godot-client"
else
  echo "  (skipped worktree rule: no linked worktree on this machine)" >&2
fi

echo "== must warn, not block =="
if [ -L "$MAIN/frontend/node_modules" ] || [ -L "$MAIN/node_modules" ]; then
  expect warn 'git add -A'
else
  expect allow 'git add -A'
  echo "  (main checkout has a real node_modules; the symlink warning is exercised in worktrees)" >&2
fi
if [ -n "$WORKTREE" ] && { [ -L "$WORKTREE/frontend/node_modules" ] || [ -L "$WORKTREE/node_modules" ]; }; then
  expect warn 'git add -A' "$WORKTREE"
fi

echo "== must allow: the documented gates =="
expect allow 'cd frontend && npx vue-tsc --noEmit && npx vitest run'
expect allow 'cd frontend && npm run build:pages'
expect allow 'cd frontend && npm run preview:pages'
expect allow 'COUCHCOOP_FRONTEND_OUT_DIR=/tmp/cc-build npm run build'
expect allow 'dotnet run --project tests/CouchCoop.MirrorProtocol.Tests'
expect allow 'dotnet build godot-client/CouchCoop.GodotClient.csproj'
expect allow 'scripts/build-local-mod.sh'
expect allow 'sts2 --instance touchqa game close'
expect allow "pkill -f 'SlayTheSpire2 --headless'"
expect allow 'scripts/run-gpu.sh node scripts/bench-mirror-replay.mjs --headed --gpu vulkan'
expect allow 'node scripts/validate-touch-live.mjs --checks H1,H3 --combos mouse-1920'
expect allow 'node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5174 --repeats 5 --res-root'
expect allow '../spirectl/scripts/validate.sh bridge-tests'
expect allow 'cd ../godot-scene-web && mise exec -- pnpm build'
expect allow 'dotnet build CouchCoop.sln'
expect allow 'COUCHCOOP_GAME_MODS_DIR=/tmp/scratch dotnet build CouchCoop.sln' "${WORKTREE:-$MAIN}"
expect allow 'bash scripts/install-agent-config.sh'
expect allow 'env -u DISPLAY -u WAYLAND_DISPLAY gamescope --backend headless -- sleep infinity'
expect allow '/tmp/gameroot/SlayTheSpire2 --headless'
expect allow 'godot --headless --path godot-client --dump-final-state'
expect allow 'xvfb-run -a npx vitest run browser.test.ts'
expect allow 'rg -n Xvfb agents docs'
expect allow 'cat docs/agents/qa-recipes.md'

echo "== must allow: every shell line in the committed agent docs =="
# Expected-deny: the docs quote these to forbid them. Anything else denied here is a false positive.
expected_deny_re='(npm run build([^:]|$)|dotnet test|pkill -f <|sts2 game deploy)'
harvested=0; flagged=0
while IFS= read -r line; do
  harvested=$((harvested+1))
  for harness in claude codex; do
    if [ "$(verdict "$line" "$MAIN" "$harness")" = deny ] \
       && ! printf '%s' "$line" | grep -Eq "$expected_deny_re"; then
      flagged=$((flagged+1))
      printf 'FAIL  [%s] guard denies a documented command: %s\n' "$harness" "$line" >&2
    fi
  done
done < <(
  awk '/^```/{inblock=!inblock; next} inblock' docs/agents/*.md docs/mirror-combat-bench.md 2>/dev/null \
  | sed 's/^[[:space:]]*//' \
  | grep -E '^(node|npx|npm|pnpm|dotnet|sts2|scripts/|\.\./|python3|adb|git|cargo|mise|xvfb-run|COUCHCOOP_|REPEATS=|EFFECTS=)' \
  | sort -u
)
fail=$((fail+flagged))
echo "  replayed $harvested documented command lines under 2 harnesses, $flagged false positives"

echo
if [ "$fail" -eq 0 ]; then
  echo "guard self-test: $pass checks passed, 0 failures"
else
  echo "guard self-test: $pass passed, $fail FAILED" >&2
  exit 1
fi
