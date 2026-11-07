#!/usr/bin/env bash
# Self-test for scripts/githooks/pre-push. Real pushes, but only from a throwaway repository to a
# local bare one under mktemp, with the working-tree copies of the hooks and the check wired in
# through core.hooksPath exactly as scripts/install-agent-config.sh wires them.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

pass=0; fail=0
TMP="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT
ok() { # ok <desc> <cmd…>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL  %s\n' "$desc" >&2; fi
}
no() { # no <desc> <cmd…> — the command must fail
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then fail=$((fail+1)); printf 'FAIL  %s\n' "$desc" >&2; else pass=$((pass+1)); fi
}

R="$TMP/repo"; BARE="$TMP/origin.git"
git init -q --bare -b main "$BARE"
git init -q -b main "$R"
git -C "$R" config user.email t@example.com
git -C "$R" config user.name t
git -C "$R" config commit.gpgsign false
mkdir -p "$R/scripts/githooks" "$R/docs"
cp "$ROOT/scripts/check-public-tree.py" "$R/scripts/"
cp "$ROOT/scripts/githooks/pre-push" "$ROOT/scripts/githooks/commit-msg" "$R/scripts/githooks/"
printf 'deny docs/agents/**\ndeny **/*-handoff.md\nallow-md README.md\n' >"$R/scripts/public-tree.conf"
printf '# readme\n' >"$R/README.md"
git -C "$R" config core.hooksPath scripts/githooks
git -C "$R" add -A && git -C "$R" commit -qm "chore: init"
git -C "$R" remote add origin "$BARE"

ok "a clean push goes through" git -C "$R" push -q origin main
ok "…and lands" git --git-dir="$BARE" rev-parse -q --verify refs/heads/main

git -C "$R" switch -q -c topic
printf 'x\n' >"$R/docs/x-handoff.md"; git -C "$R" add docs && git -C "$R" commit -qm "add handoff"
git -C "$R" push origin topic >"$TMP/out" 2>&1; rc=$?
ok "a push whose tree has a denied file is refused" test "$rc" != 0
ok "…and the branch did not land" bash -c "! git --git-dir='$BARE' rev-parse -q --verify refs/heads/topic"
ok "…with the check's reason" grep -q '\[deny\] docs/x-handoff.md' "$TMP/out"
ok "…and the hook's own line" grep -q 'pre-push: refused' "$TMP/out"

git -C "$R" rm -q docs/x-handoff.md && git -C "$R" commit -qm "drop it"
git -C "$R" push origin topic >"$TMP/out" 2>&1; rc=$?
ok "a range that added a denied file is refused even when the tip is clean" test "$rc" != 0
ok "…naming the path" grep -q 'docs/x-handoff.md: added or changed by' "$TMP/out"

git -C "$R" switch -q main && git -C "$R" switch -q -c topic2
printf 'more\n' >>"$R/README.md" && git -C "$R" commit -qam "touch readme"
ok "a clean new branch goes through" git -C "$R" push -q origin topic2
ok "a branch deletion goes through" git -C "$R" push -q origin :topic2
ok "…and deletes" bash -c "! git --git-dir='$BARE' rev-parse -q --verify refs/heads/topic2"

ok "several refs in one push: all clean pass" git -C "$R" push -q origin main main:refs/heads/copy
no "several refs in one push: one bad ref fails the push" git -C "$R" push -q origin topic main:refs/heads/copy2

ok "--no-verify still bypasses (documented escape hatch)" git -C "$R" push -q --no-verify origin topic

# The commit-msg hook sits beside it and still runs.
ok "the commit-msg hook is still installed" test -x "$R/scripts/githooks/commit-msg"
ok "the pre-push hook is executable" test -x "$ROOT/scripts/githooks/pre-push"
ok "the pre-push hook is POSIX sh" sh -n "$ROOT/scripts/githooks/pre-push"

echo
if [ "$fail" -eq 0 ]; then echo "pre-push hook self-test: $pass checks passed, 0 failures"
else echo "pre-push hook self-test: $pass passed, $fail FAILED" >&2; exit 1; fi
