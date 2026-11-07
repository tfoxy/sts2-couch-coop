#!/usr/bin/env bash
# Self-test for scripts/check-public-tree.py. Every case runs in a throwaway git repository under
# mktemp, with the working-tree copy of the script and a small conf of its own, so this gates
# uncommitted work and never reads this checkout's real rules or private overlay.
#
# The personal-data-shaped values are assembled at run time, so this file itself stays clean under
# the real conf's text scan.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
CHECK_SRC="$ROOT/scripts/check-public-tree.py"

pass=0; fail=0
TMP="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT
ZERO=0000000000000000000000000000000000000000
ID_PREFIX="7656119"
FAKE_ID="${ID_PREFIX}8000000001"          # Steam64-shaped, not the placeholder
PLACEHOLDER="${ID_PREFIX}7960265729"      # the documented placeholder (allow-text)
SECRET="private-literal-$RANDOM-xyzzy"     # only ever listed in the private overlay

ok() { # ok <desc> <cmd…>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL  %s\n' "$desc" >&2; fi
}
rc_is() { # rc_is <desc> <want> <got>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL  %s (want rc %s, got %s)\n' "$1" "$2" "$3" >&2; fi
}

# new_repo <dir>: a repo with the script, a conf, an allowlisted doc and one commit.
new_repo() {
  local d="$1"
  git init -q -b main "$d"
  git -C "$d" config user.email t@example.com
  git -C "$d" config user.name t
  git -C "$d" config commit.gpgsign false
  mkdir -p "$d/scripts" "$d/docs" "$d/packages/core"
  cp "$CHECK_SRC" "$d/scripts/check-public-tree.py"
  cat >"$d/scripts/public-tree.conf" <<CONF
# test conf
deny private
deny private/**
deny docs/agents/**
deny **/results/**
deny **/handoff-*
deny **/*-handoff.md
deny-text \\b${ID_PREFIX}[0-9]{10}\\b
allow-text ${PLACEHOLDER}
allow-md README.md
allow-md docs/guide.md
allow-md packages/*/README.md
CONF
  printf '# readme\n' >"$d/README.md"
  printf '# guide\n\nExample id: %s\n' "$PLACEHOLDER" >"$d/docs/guide.md"
  printf '# core\n' >"$d/packages/core/README.md"
  printf 'code\n' >"$d/packages/core/index.ts"
  printf '/private\n' >"$d/.gitignore"
  git -C "$d" add -A && git -C "$d" commit -qm init
}
run() { # run <repo> <args…> — stdout+stderr to $TMP/out, echoes the exit code
  local d="$1"; shift
  (cd "$d" && python3 scripts/check-public-tree.py "$@") >"$TMP/out" 2>&1
  echo $?
}

echo "== glob semantics =="
ok "glob: ** spans zero or more segments, * stays in one" python3 - "$CHECK_SRC" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("c", sys.argv[1])
c = importlib.util.module_from_spec(spec); sys.modules["c"] = c; spec.loader.exec_module(c)
g = lambda pat, path: bool(c.glob_to_regex(pat).match(path))
cases = [
    ("**/results/**", "results/x.md", True), ("**/results/**", "a/b/results/c/d.json", True),
    ("**/results/**", "a/results", False), ("docs/*.md", "docs/a.md", True),
    ("docs/*.md", "docs/sub/a.md", False), ("packages/*/README.md", "packages/core/README.md", True),
    ("packages/*/README.md", "packages/a/b/README.md", False), ("fixtures/**/README.md", "fixtures/README.md", True),
    ("fixtures/**/README.md", "fixtures/a/b/README.md", True), ("**/handoff-*", "handoff-x.md", True),
    ("**/handoff-*", "docs/handoff-x.md", True), ("**/handoff-*", "docs/xhandoff-x.md", False),
    ("a?c", "abc", True), ("a?c", "a/c", False), ("v[0-9].md", "v1.md", True), ("v[!0-9].md", "v1.md", False),
    ("a.b", "aXb", False), ("private", "private", True), ("private/**", "private/a/b", True),
]
bad = [(p, s, w) for p, s, w in cases if g(p, s) != w]
print(bad)
sys.exit(1 if bad else 0)
PY

echo "== index mode =="
R="$TMP/r1"; new_repo "$R"
rc_is "an allowlisted tree is clean" 0 "$(run "$R")"
ok "…and says so" grep -q 'clean' "$TMP/out"
ok "the placeholder id is allowed (allow-text)" grep -q 'clean' "$TMP/out"

printf 'x\n' >"$R/docs/foo-handoff.md"; git -C "$R" add docs/foo-handoff.md
rc_is "a planted docs/foo-handoff.md fails" 1 "$(run "$R")"
ok "…as a deny hit naming the rule" grep -q '\[deny\] docs/foo-handoff.md: matches deny `\*\*/\*-handoff.md`' "$TMP/out"
git -C "$R" rm -q --cached docs/foo-handoff.md; rm "$R/docs/foo-handoff.md"

printf 'x\n' >"$R/docs/notes.md"; git -C "$R" add docs/notes.md
rc_is "a non-allowlisted docs/notes.md fails" 1 "$(run "$R")"
ok "…as an allow-md hit" grep -q '\[allow-md\] docs/notes.md' "$TMP/out"
git -C "$R" rm -q --cached docs/notes.md
rc_is "an untracked md is not checked (index mode)" 0 "$(run "$R")"
rm "$R/docs/notes.md"

mkdir -p "$R/exp/results/x"; printf '{}\n' >"$R/exp/results/x/a.json"; git -C "$R" add exp
rc_is "a non-md file under results/ fails" 1 "$(run "$R")"
ok "…via its parent directory" grep -q '\[deny\] exp/results/x/a.json' "$TMP/out"
git -C "$R" rm -rq --cached exp; rm -rf "$R/exp"

printf 'const id = "%s";\n' "$FAKE_ID" >"$R/packages/core/ids.ts"; git -C "$R" add packages/core/ids.ts
rc_is "a Steam64-like id fails" 1 "$(run "$R")"
ok "…with file:line" grep -q '\[deny-text\] packages/core/ids.ts:1' "$TMP/out"
ok "…and never echoes the matched text" bash -c "! grep -qF '$FAKE_ID' '$TMP/out'"
printf 'const id = "%s"; // and %s\n' "$PLACEHOLDER" "$FAKE_ID" >"$R/packages/core/ids.ts"; git -C "$R" add packages/core/ids.ts
rc_is "a placeholder on the line does not exempt another id" 1 "$(run "$R")"
printf 'const id = "%s";\n' "$PLACEHOLDER" >"$R/packages/core/ids.ts"; git -C "$R" add packages/core/ids.ts
rc_is "the placeholder alone passes" 0 "$(run "$R")"
printf '\0binary %s\n' "$FAKE_ID" >"$R/packages/core/blob.bin"; git -C "$R" add packages/core/blob.bin
rc_is "binary files are not text-scanned" 0 "$(run "$R")"
git -C "$R" rm -q --cached packages/core/blob.bin packages/core/ids.ts; rm "$R/packages/core/blob.bin" "$R/packages/core/ids.ts"

# The script and its conf spell out the patterns they deny.
printf '# %s\n' "$FAKE_ID" >>"$R/scripts/public-tree.conf"; git -C "$R" add scripts/public-tree.conf
rc_is "the conf itself is exempt from the text scan" 0 "$(run "$R")"
git -C "$R" checkout -q HEAD -- scripts/public-tree.conf

echo "== private overlay =="
mkdir -p "$R/private"
printf 'deny-text %s\nallow-md docs/private-listed.md\n' "$SECRET" >"$R/private/public-tree-private.conf"
printf 'see %s here\n' "$SECRET" >"$R/docs/guide2.txt"; git -C "$R" add docs/guide2.txt
rc_is "a private-overlay literal fails" 1 "$(run "$R")"
ok "…reported by file:line and rule number" grep -q '\[deny-text\] docs/guide2.txt:1: matches private deny-text rule #2' "$TMP/out"
ok "…without echoing the literal" bash -c "! grep -qF '$SECRET' '$TMP/out'"
git -C "$R" rm -q --cached docs/guide2.txt; rm "$R/docs/guide2.txt"
printf '# x\n' >"$R/docs/private-listed.md"; git -C "$R" add docs/private-listed.md
rc_is "overlay allow-md rules apply" 0 "$(run "$R")"
git -C "$R" rm -q --cached docs/private-listed.md; rm "$R/docs/private-listed.md"
ok "the private dir is not tracked (gitignored)" test -z "$(git -C "$R" ls-files private)"
rm -rf "$R/private"

echo "== --rev mode =="
printf 'x\n' >"$R/docs/notes.md"; git -C "$R" add docs/notes.md; git -C "$R" commit -qm bad
rc_is "--rev HEAD sees the committed bad doc" 1 "$(run "$R" --rev HEAD)"
rc_is "--rev HEAD~1 is clean" 0 "$(run "$R" --rev HEAD~1)"
git -C "$R" reset -q --hard HEAD~1
rc_is "an unknown rev is a usage error" 2 "$(run "$R" --rev no-such-rev)"
rc_is "an unknown flag is a usage error" 2 "$(run "$R" --frobnicate)"
mv "$R/scripts/public-tree.conf" "$TMP/conf.bak"
git -C "$R" rm -q --cached scripts/public-tree.conf
rc_is "a missing conf is a configuration error" 2 "$(run "$R")"
mv "$TMP/conf.bak" "$R/scripts/public-tree.conf"; git -C "$R" add scripts/public-tree.conf
printf 'bogus-kind x\n' >>"$R/scripts/public-tree.conf"
rc_is "an unknown rule kind is a configuration error" 2 "$(run "$R")"
ok "…naming file:line" grep -q 'public-tree.conf:[0-9]*:' "$TMP/out"
git -C "$R" checkout -q HEAD -- scripts/public-tree.conf

echo "== --push =="
# A remote to push to, so remote-tracking refs exist.
BARE="$TMP/origin.git"; git init -q --bare -b main "$BARE"
git -C "$R" remote add origin "$BARE"; git -C "$R" push -q origin main
base="$(git -C "$R" rev-parse HEAD)"

git -C "$R" switch -q -c topic
printf 'more\n' >>"$R/packages/core/index.ts"; git -C "$R" commit -qam "code change"
head="$(git -C "$R" rev-parse HEAD)"
rc_is "--push with a zero remote sha (new branch) works" 0 "$(run "$R" --push "$head" "$ZERO" origin)"
ok "…checking only the commits not on origin" grep -q 'not on origin (1 commits)' "$TMP/out"
rc_is "--push with a known remote sha works" 0 "$(run "$R" --push "$head" "$base" origin)"
ok "…over remote..local" grep -q '(1 commits)' "$TMP/out"
rc_is "--push with a zero remote sha and a URL remote works" 0 "$(run "$R" --push "$head" "$ZERO" "$BARE")"
rc_is "--push of a deletion (zero local sha) passes" 0 "$(run "$R" --push "$ZERO" "$base" origin)"

# A denied path added and removed again inside the pushed range: the tree is clean, history is not.
mkdir -p "$R/docs/agents"; printf 'x\n' >"$R/docs/agents/note.txt"
git -C "$R" add docs/agents && git -C "$R" commit -qm "add internal note"
git -C "$R" rm -rq docs/agents && git -C "$R" commit -qm "drop it again"
head2="$(git -C "$R" rev-parse HEAD)"
rc_is "--rev of the final tree is clean" 0 "$(run "$R" --rev "$head2")"
rc_is "--push refuses a range that added a deny path" 1 "$(run "$R" --push "$head2" "$ZERO" origin)"
ok "…naming the path and the commit" grep -q '\[deny\] docs/agents/note.txt: added or changed by' "$TMP/out"
# Publishing the addition first, then pushing only the deletion: the pushed range deletes only.
git -C "$R" push -q --no-verify origin "$head2~1:refs/heads/topic"
rc_is "a deletion-only push of a deny path passes" 0 "$(run "$R" --push "$head2" "$(git -C "$R" rev-parse "$head2~1")" origin)"

echo "== --push: pre-rewrite ancestry =="
old_root="$(git -C "$R" rev-list --max-parents=0 HEAD)"
printf 'old-root %s\n' "$old_root" >>"$R/scripts/public-tree.conf"
rc_is "--push refuses a ref descending from an old-root" 1 "$(run "$R" --push "$head" "$ZERO" origin)"
ok "…and says how to port it" grep -q 'private/rewrite/port-branch.sh' "$TMP/out"
# A history that does not descend from it (a rewritten one) passes.
NEW="$TMP/r2"; new_repo "$NEW"
printf 'old-root %s\n' "$old_root" >>"$NEW/scripts/public-tree.conf"
git -C "$NEW" commit -qam "carry the old root"
rc_is "--push of an unrelated (rewritten) history passes" 0 "$(run "$NEW" --push HEAD "$ZERO" origin)"
ok "an old-root object this repo has never seen is not an error" grep -q clean "$TMP/out"
printf 'old-root deadbeef\n' >>"$NEW/scripts/public-tree.conf"
rc_is "a short old-root sha is a configuration error" 2 "$(run "$NEW")"
git -C "$NEW" checkout -q HEAD -- scripts/public-tree.conf

echo "== timing =="
start="$(date +%s%N)"; (cd "$ROOT" && python3 scripts/check-public-tree.py >/dev/null 2>&1); end="$(date +%s%N)"
ms=$(( (end - start) / 1000000 ))
echo "    this checkout's index: ${ms} ms"
ok "the real tree is checked in under 1 s" test "$ms" -lt 1000

echo
if [ "$fail" -eq 0 ]; then echo "check-public-tree self-test: $pass checks passed, 0 failures"
else echo "check-public-tree self-test: $pass passed, $fail FAILED" >&2; exit 1; fi
