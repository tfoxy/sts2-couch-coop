#!/usr/bin/env bash
# PreToolUse(Bash) guard for sts2-couch-coop.
#
# Every rule here corresponds to a command that has silently destroyed work or produced a
# confident-but-meaningless result in this repo, and that is documented in docs/agents/qa-recipes.md
# section 7. Prose rules only help an agent that read the prose; this catches the rest.
#
# Contract (verified against https://code.claude.com/docs/en/hooks.md):
#   stdin  = hook JSON, bash command at .tool_input.command
#   deny   = exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#                      "permissionDecision":"deny","permissionDecisionReason":"..."}}
#   warn   = exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}
#   allow  = exit 0, no output
# PreToolUse hooks fire in ALL permission modes, including bypassPermissions, so a deny here holds.
#
# Self-test: scripts/test-claude-guard.sh (asserts both what it blocks AND what it must not block).

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // ""')"
[ -n "$cmd" ] || exit 0

deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
warn() {
  jq -n --arg c "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
  exit 0
}
has() { printf '%s' "$cmd" | grep -Eq "$1"; }

# Game displays: block explicit Xvfb servers and known game commands in Xvfb wrappers.
# Browser-only GPU test wrappers remain valid. This checks command text, not shell semantics.
if has '(^|[;&|])[[:space:]]*((env|setsid|nohup)[[:space:]]+([^;&|]*[[:space:]])?)?(/[^[:space:]]*/)?Xvfb([[:space:]]|$)' \
   || { has '(xvfb-run|run-gpu\.sh)' \
        && has '(SlayTheSpire2|Godot[^[:space:]]*|(^|[[:space:];&|/])godot([[:space:]]|$)|(^|[[:space:];&|/])sts2([[:space:]]|$))'; }; then
  deny "Xvfb is forbidden for game instances. Use Godot --headless for nonvisual checks, or gamescope --backend headless for screenshots and GPU rendering (preferred; verify NVIDIA RTX 2060 on this workstation).

Verify the private display connection and compositor PID/start identity, and stop the owned game if the compositor dies. Never fall back to the desktop. A visible game requires explicit user permission before launch. See AGENTS.md and qa-recipes section 2.x."
fi

# A command that explicitly reaches into a sibling repo is that repo's business, not ours.
targets_sibling() { has '(\.\./|/)(spirectl|godot-scene-web)(/|$)'; }

# ---------------------------------------------------------------------------------------------
# 1. `npm run build` in frontend/ DEPLOYS: its Vite outDir is the installed mod's frontend dir,
#    so a branch build overwrites the live install with unmerged code (qa-recipes.md "Gotchas").
#    `build:pages` is exempt — it has its own pages-dist outDir and ships only the bootstrap.
# ---------------------------------------------------------------------------------------------
if ! targets_sibling \
   && ! has 'COUCHCOOP_FRONTEND_OUT_DIR=' \
   && { has '(npm|pnpm|yarn)[[:space:]]+run[[:space:]]+build([[:space:]]|$|&|;|\|)' \
        || has '(npm|pnpm|yarn)[[:space:]]+run[[:space:]]+build:watch' \
        || has '(^|[[:space:];&|])(npx[[:space:]]+)?vite[[:space:]]+build'; }; then
  deny "\`npm run build\` in frontend/ DEPLOYS — its Vite outDir is the installed mod's frontend dir, so this overwrites the live game install with whatever is in this working tree.

Use the typecheck gate instead:
  cd frontend && npx vue-tsc --noEmit && npx vitest run

Really need bundle output? Point it somewhere scratch:
  COUCHCOOP_FRONTEND_OUT_DIR=/tmp/cc-build npm run build
Deploying for real is scripts/build-local-mod.sh (see the couch-deploy skill).
\`npm run build:pages\` is fine — it has its own pages-dist outDir."
fi

# ---------------------------------------------------------------------------------------------
# 2. The C# suites are custom `Exe` runners that self-register in Program.cs. `dotnet test`
#    finds no test adapter, exits 0, and reports nothing — a silent pass (qa-recipes.md section 6).
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])dotnet[[:space:]]+test' \
   && { has 'CouchCoop\.(MirrorProtocol|Mod)\.Tests' || has 'CouchCoop\.sln' \
        || has '(^|[[:space:];&|])dotnet[[:space:]]+test[[:space:]]*($|[;&|])'; }; then
  deny "\`dotnet test\` is a SILENT NO-OP on this repo's C# suites — they are custom \`Exe\` runners whose suites self-register in Program.cs, so there is no test adapter to find. It exits 0 having run nothing.

Run them as programs:
  dotnet run --project tests/CouchCoop.MirrorProtocol.Tests
  dotnet run --project tests/CouchCoop.Mod.Tests"
fi

# ---------------------------------------------------------------------------------------------
# 3. `sts2 game close` with no --instance closes the DEVELOPER's live game on :13337, not the
#    named QA instance you meant (touch-live-harness.md "Safety").
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])sts2([[:space:]]+[^;&|]*)?[[:space:]]+game[[:space:]]+close' && ! has '\-\-instance'; then
  deny "\`sts2 game close\` without \`--instance\` targets the DEVELOPER's live game (:13337), not your QA instance.

Name the instance you actually started:
  sts2 --instance touchqa game close
If you genuinely meant the live host, you need the live lock first (see the couch-live-lock skill)."
fi

# ---------------------------------------------------------------------------------------------
# 4. `pkill -f` self-matches: a pattern that also appears in the invoking shell's own argv kills
#    the invoking shell (exit 144, no output). And COUCHCOOP_* are ENV vars, not argv — `pkill -f`
#    against them matches nothing at all (qa-recipes.md "Gotchas").
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])pkill([[:space:]]+-[A-Za-z0-9]+)*[[:space:]]+-[A-Za-z]*f'; then
  if has 'COUCHCOOP_[A-Z_]+'; then
    deny "\`pkill -f COUCHCOOP_…\` matches NOTHING — those are environment variables, not argv.

The real headless process pattern is:
  pkill -f 'SlayTheSpire2 --headless'
Run the kill and the relaunch as SEPARATE Bash calls."
  fi
  if has '(sts2-couch-coop|cc-[A-Za-z0-9_-]+)'; then
    deny "This \`pkill -f\` pattern contains a repo path, which also appears in the invoking shell's own argv — it will kill the shell running it (exit 144, no output).

Match the process, not the path:
  pkill -f 'SlayTheSpire2 --headless'
Run the kill and the relaunch as SEPARATE Bash calls."
  fi
fi

# ---------------------------------------------------------------------------------------------
# 5. Nested xvfb deadlocks. scripts/run-gpu.sh IS an xvfb-run wrapper, and godot-scene-web's
#    `test:*Xvfb` / `bench:canvas-upload` scripts already wrap themselves
#    (docs/mirror-combat-bench.md, gsw docs).
# ---------------------------------------------------------------------------------------------
if has 'run-gpu\.sh' && has 'xvfb-run'; then
  deny "Nested xvfb: scripts/run-gpu.sh IS the xvfb-run wrapper (xvfb-run -a -s '-screen 0 2560x1440x24'). Wrapping another one around it deadlocks.

Use one or the other:
  scripts/run-gpu.sh node scripts/bench-mirror-replay.mjs --headed --gpu vulkan …"
fi
if has 'run-gpu\.sh' \
   && has '(test:(webgpu-composite|webgl-composite|canvas-pixel)|bench:canvas-upload|[A-Za-z-]*[Xx]vfb\.test\.ts)'; then
  deny "godot-scene-web's self-wrapping scripts (test:webgpu-composite, test:webgl-composite, test:canvas-pixel, bench:canvas-upload) already run under xvfb-run — putting run-gpu.sh around one deadlocks.

Run the INNER vitest under the wrapper instead:
  scripts/run-gpu.sh npx vitest run packages/test-harness/test/<name>Xvfb.test.ts"
fi

# ---------------------------------------------------------------------------------------------
# 6. Any `dotnet build` of the solution DEPLOYS: Directory.Build.props resolves modsDir from the
#    checkout's own sts2.local.yaml. From a linked worktree that silently replaces the live
#    install with the worktree's code (qa-recipes.md "Gotchas").
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])dotnet[[:space:]]+(build|run|publish)' \
   && ! has 'COUCHCOOP_GAME_MODS_DIR=' \
   && [ -z "${COUCHCOOP_GAME_MODS_DIR:-}" ] \
   && [ -n "$cwd" ]; then
  # --path-format=absolute on BOTH, or the comparison is meaningless: from a subdirectory git
  # prints --git-dir absolute and --git-common-dir relative ("../.git"), which made every
  # `dotnet build` from e.g. frontend/ in the MAIN checkout look like a worktree build.
  gitdir="$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  commondir="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$gitdir" ] && [ -n "$commondir" ] && [ "$gitdir" != "$commondir" ]; then
    deny "You are in a linked WORKTREE and \`COUCHCOOP_GAME_MODS_DIR\` is unset. Any dotnet build/run here DEPLOYS — Directory.Build.props resolves modsDir from this worktree's sts2.local.yaml and copies into the live mods dir, silently replacing whatever is installed.

Point it at scratch first:
  COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-\$(basename \"\$PWD\") dotnet build …
or strip modsDir/game.path from this worktree's copied sts2.local.yaml.
Recover a poisoned install with scripts/build-local-mod.sh from main + a game restart."
  fi
fi

# ---------------------------------------------------------------------------------------------
# 7. WARN: .gitignore's `node_modules/` (trailing slash = directories only) does not match a
#    node_modules SYMLINK, and worktrees use symlinked node_modules. One landed in a merge.
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$|&|;|\|)' && [ -n "$cwd" ]; then
  root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$root" ] && { [ -L "$root/frontend/node_modules" ] || [ -L "$root/node_modules" ]; }; then
    warn "Heads up: this tree has a SYMLINKED node_modules, and .gitignore's \`node_modules/\` pattern (trailing slash = directories only) does not match a symlink. A blanket \`git add -A\` can commit it — that has happened before. Check \`git status\` for node_modules, or add paths explicitly."
  fi
fi

exit 0
