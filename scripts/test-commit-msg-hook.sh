#!/usr/bin/env bash
# Self-test for scripts/githooks/commit-msg.
#
# Two-sided, like scripts/test-claude-guard.sh: a hook that rejects a legitimate message is worse
# than no hook, so the MUST-PASS half carries every shape this repo's history actually uses —
# one-liners, scoped types, breaking changes, release commits, merges, reverts, fixups, and a raw
# message file still carrying git's comments and --verbose diff.
#
# Every rejection case is asserted twice: rejected on main, and SILENT on a feature branch, because
# "feature branches are never blocked" is the property that keeps the hook out of an agent's way.
#
# Nothing here commits. Messages are fed to the hook as files, the way git invokes it.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HOOK="$PWD/scripts/githooks/commit-msg"

pass=0; fail=0
TMP="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT

# Runs the hook over a message, on main unless a branch is given. Echoes the exit code; stderr
# lands in $TMP/err for the message assertions.
run() { # run <message> [branch]
  printf '%s\n' "$1" > "$TMP/msg"
  env COMMIT_HOOK_BRANCH="${2:-main}" bash "$HOOK" "$TMP/msg" > "$TMP/out" 2> "$TMP/err"
  echo $?
}

accepts() { # accepts <desc> <message>
  local got; got="$(run "$2")"
  if [ "$got" = 0 ]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  should ACCEPT: %s\n' "$1" >&2; sed 's/^/        /' "$TMP/err" >&2; fi
}

rejects() { # rejects <desc> <message> [expected substring in stderr]
  local got; got="$(run "$2")"
  if [ "$got" = 1 ]; then
    pass=$((pass+1))
    if [ "${3:-}" != "" ] && ! grep -qF "$3" "$TMP/err"; then
      fail=$((fail+1)); printf 'FAIL  rejected but without the guidance %s: %s\n' "'$3'" "$1" >&2
    fi
  else
    fail=$((fail+1)); printf 'FAIL  should REJECT (got exit %s): %s\n' "$got" "$1" >&2
  fi
  # The same message must sail through on a feature branch.
  got="$(run "$2" "cc-some-round")"
  if [ "$got" = 0 ]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  blocked on a FEATURE BRANCH: %s\n' "$1" >&2; fi
}

echo "== must accept =="
accepts "a bare one-liner"            'chore(scripts): drop the stale resource cache path'
accepts "no scope"                    'refactor: retire the transform-space compatibility metadata'
accepts "deep scope"                  'test(frontend/mirror): cover shop removal touch routes'
accepts "subject of exactly 72" "$(printf 'feat: %066d\n\nbody\n\nChangelog: yes' 1)"
accepts "feat with a changelog line" 'feat(frontend): support touch shop card removal

Route removal taps through the shop picker so a card can be removed by touch
alone, matching the mouse path.

Changelog: You can now remove a card at the merchant by tapping it.'
accepts "fix with Changelog: none"   'fix(validation): scan tracked blobs reliably

Changelog: none'
accepts "perf with a trailer"        'perf(mirror): park still encodes off the frame path

Changelog: Smoother card animations on slower phones.'
accepts "a breaking change"          'feat(protocol)!: drop the v1 browser state reader

BREAKING CHANGE: clients older than 0.1.0 can no longer join.

Changelog: Older cached browser tabs must be reloaded once after updating.'
accepts "the release commit"         'chore(release): v0.1.2'
accepts "a merge commit"             "Merge branch 'cc-r21-b5-gradient'"
accepts "a revert"                   'Revert "feat(frontend): support touch shop card removal"'
accepts "a fixup"                    'fixup! feat(frontend): support touch shop card removal'
accepts "types needing no trailer"   'docs(agents): describe the generic asset misses'
accepts "an unwrappable long line"   "chore(deps): pin the release action

https://github.com/actions/checkout/commit/fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
accepts "a fenced block"             'docs(qa): record the deploy command

```
dotnet run --project tests/CouchCoop.Mod.Tests -- --filter "a very long filter expression that runs past one hundred columns"
```'

echo "== must accept: a raw message file as git hands it over =="
accepts "comments and a scissors diff" 'chore(scripts): drop the stale resource cache path

# Please enter the commit message for your changes. Lines starting
# with '"'"'#'"'"' will be ignored, and an empty message aborts the commit.
#
# On branch main
# ------------------------ >8 ------------------------
# Do not modify or remove the line above.
diff --git a/scripts/x.sh b/scripts/x.sh
index 1234567..89abcde 100644
--- a/scripts/x.sh
+++ b/scripts/x.sh
@@ -1,3 +1,3 @@ this line is well past one hundred columns and must not be measured at all'

echo "== must reject =="
rejects "prose with no type"    'Default raise-hand cards to off on all devices' \
        'subject must start with a type'
rejects "a retired prefix"      'cleanup(mirror): retire the item z-rule switch' \
        'cleanup -> refactor'
rejects "an invented type"      'bench: add the KNIGHTS_ELITE gate' \
        'unknown commit type'
rejects "a trailing period"     'chore(scripts): drop the stale cache path.' \
        'must not end with a period'
rejects "a 73-char subject" "$(printf 'feat: %067d' 1)" \
        'limit is 72'
rejects "no blank line 2"       'fix(mod): clear nullable warning regressions
Body starts immediately.

Changelog: none' \
        'line 2 must be blank'
rejects "an overlong body line" "docs(agents): describe the router

$(printf 'word %.0s' $(seq 1 25))" \
        'limit is 100'
rejects "feat without a trailer" 'feat(frontend): support touch shop card removal

Route removal taps through the shop picker.' \
        'Changelog: none'
rejects "an empty trailer value" 'fix(validation): scan tracked blobs reliably

Changelog:' \
        'needs a `Changelog:` trailer'
rejects "a misspelled trailer"  'fix(validation): scan tracked blobs reliably

changelog: something happened' \
        'spelled exactly'
rejects "uppercase type"        'Fix: scan tracked blobs reliably

Changelog: none' \
        'unknown commit type'

echo "== multiple problems are reported together =="
got="$(run 'Fix the thing.')"
if [ "$got" = 1 ] && grep -q '2 problem(s)' "$TMP/err"; then pass=$((pass+1))
else fail=$((fail+1)); printf 'FAIL  expected both the missing type and the trailing period\n' >&2; fi

echo "== an empty message is git's error, not ours =="
accepts "an empty message" ''
accepts "only comments"    '# On branch main
# Untracked files:'

echo
if [ "$fail" -eq 0 ]; then
  echo "commit-msg self-test: $pass checks passed, 0 failures"
else
  echo "commit-msg self-test: $pass passed, $fail FAILED" >&2
  exit 1
fi
