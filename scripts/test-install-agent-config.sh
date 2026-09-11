#!/usr/bin/env bash
# Self-test for scripts/install-agent-config.sh (and scripts/gen-codex-config.py).
#
# Everything happens in a THROWAWAY detached worktree under mktemp -d, so the checkout you run this
# from is never modified. The working-tree copies of scripts/, agents/ and skills/ are copied into
# it, so this gates uncommitted work rather than HEAD.
#
# The `--user` half is hermetic: a fake $HOME plus a stub `codex` on PATH that records its argv.
# Nothing here ever writes into the real ~/.claude, ~/.codex, or the real project memory store —
# the memory assertions only look at a symlink target. (The installer does `mkdir -p` the main
# checkout's .agents/memory, which is the point of it; it never puts files there.)

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
MEMORY="$MAIN/.agents/memory"

pass=0; fail=0
eq() { # eq <desc> <want> <got>
  if [ "$2" = "$3" ]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$2" "$3" >&2; fi
}
ok() { # ok <desc> <cmd…>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  %s\n' "$desc" >&2; fi
}
die() { printf 'setup failed: %s\n' "$1" >&2; exit 1; }

tomlq() { # tomlq <file> <python expr over `d`>
  python3 -c 'import sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); print(eval(sys.argv[2]))' "$1" "$2"
}

TMP="$(mktemp -d)" || die "mktemp"
WT="$TMP/wt"
WT2="$TMP/wt2"
WT3="$TMP/wt3"
cleanup() {
  for w in "$WT" "$WT2" "$WT3"; do
    [ -d "$w" ] && git -C "$REPO" worktree remove --force "$w" >/dev/null 2>&1
  done
  git -C "$REPO" worktree prune >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

git -C "$REPO" worktree add --detach "$WT" HEAD >/dev/null 2>&1 || die "git worktree add"
for d in scripts agents skills; do
  cp -a "$REPO/$d/." "$WT/$d/" || die "copy $d"
done

# ---------------------------------------------------------------------------------------------
# Fixtures the installer has to cope with.
# ---------------------------------------------------------------------------------------------
# Sibling repos live next to the checkout; $WT/../spirectl is $TMP/spirectl.
mkdir -p "$TMP/spirectl/skills/spirectl" "$TMP/godot-qa/skills/godot-qa"
printf -- '---\nname: spirectl\ndescription: stub\n---\n' > "$TMP/spirectl/skills/spirectl/SKILL.md"
printf -- '---\nname: godot-qa\ndescription: stub\n---\n' > "$TMP/godot-qa/skills/godot-qa/SKILL.md"

# A locally installed skill is a REAL directory and must never be replaced by a symlink.
mkdir -p "$WT/.claude/skills/godot-qa"
printf 'local\n' > "$WT/.claude/skills/godot-qa/MARKER"

# Symlinks left behind by a deleted agent or skill. The installer must prune both of these, and must
# leave a still-valid symlink and a real directory in those same directories alone.
mkdir -p "$WT/.claude/agents" "$WT/.agents/skills" "$WT/.claude/skills/kept-real-dir"
ln -s ../../agents/deleted-agent.md "$WT/.claude/agents/deleted-agent.md"
ln -s ../../skills/deleted-skill    "$WT/.agents/skills/deleted-skill"
ln -s ../../AGENTS.md               "$WT/.claude/agents/kept-link.md"
printf -- '---\nname: kept-real-dir\ndescription: stub\n---\n' > "$WT/.claude/skills/kept-real-dir/SKILL.md"

# Pre-existing settings that must survive the jq merges.
printf '%s' '{"permissions":{"allow":["Bash(echo:*)"]}}' > "$WT/.claude/settings.local.json"
printf '%s' '{"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo other"}]}]}}' \
  > "$WT/.claude/settings.json"

# NOTE: no /.mcp.json is seeded here on purpose — a fresh worktree genuinely has none, and the first
# install has to be the one that links the main checkout's copy in.

echo "== install (repo-local, no --user) =="
INSTALL_LOG="$TMP/install.log"
FAKEHOME_RO="$TMP/home-untouched"
mkdir -p "$FAKEHOME_RO/.claude"
printf '# user rules\n' > "$FAKEHOME_RO/.claude/CLAUDE.md"
env HOME="$FAKEHOME_RO" bash "$WT/scripts/install-agent-config.sh" > "$INSTALL_LOG" 2>&1
eq "installer exits 0" 0 "$?"
ok "no home-dir writes without --user" test ! -e "$FAKEHOME_RO/.codex"

echo "== Claude Code layout =="
for f in "$WT"/agents/*.md; do
  n="$(basename "$f")"
  ok ".claude/agents/$n is a symlink"      test -L "$WT/.claude/agents/$n"
  ok ".claude/agents/$n resolves"          test -e "$WT/.claude/agents/$n"
done
for d in "$WT"/skills/*/; do
  n="$(basename "$d")"
  ok ".claude/skills/$n resolves"          test -e "$WT/.claude/skills/$n"
  ok ".agents/skills/$n resolves"          test -e "$WT/.agents/skills/$n"
done
ok "sibling skill .agents/skills/spirectl is a symlink"  test -L "$WT/.agents/skills/spirectl"
ok "sibling skill .agents/skills/spirectl resolves"      test -e "$WT/.agents/skills/spirectl/SKILL.md"
ok "sibling skill .agents/skills/godot-qa resolves"      test -e "$WT/.agents/skills/godot-qa/SKILL.md"
ok "a real skill dir is not replaced"                    test -f "$WT/.claude/skills/godot-qa/MARKER"
ok "a real skill dir stays a real dir"                   test ! -L "$WT/.claude/skills/godot-qa"

echo "== dangling links =="
ok "a dangling .claude/agents symlink is pruned" test ! -L "$WT/.claude/agents/deleted-agent.md"
ok "a dangling .agents/skills symlink is pruned" test ! -L "$WT/.agents/skills/deleted-skill"
ok "…and each removal is printed"                grep -q 'removed .claude/agents/deleted-agent.md' "$INSTALL_LOG"
ok "…for both directories"                       grep -q 'removed .agents/skills/deleted-skill' "$INSTALL_LOG"
ok "a still-valid symlink is kept"               test -L "$WT/.claude/agents/kept-link.md"
ok "…and it still resolves"                      test -e "$WT/.claude/agents/kept-link.md"
ok "a real directory is left alone"              test -f "$WT/.claude/skills/kept-real-dir/SKILL.md"
ok "…and stays a real directory"                 test ! -L "$WT/.claude/skills/kept-real-dir"

echo "== settings =="
eq "settings.json keeps exactly one guard hook" 1 \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("claude-guard-bash"))] | length' "$WT/.claude/settings.json")"
eq "settings.json preserves a foreign hook" "echo other" \
  "$(jq -r '[.hooks.PreToolUse[].hooks[] | select(.command == "echo other")][0].command' "$WT/.claude/settings.json")"
eq "settings.local.json autoMemoryDirectory" "$MEMORY" \
  "$(jq -r '.autoMemoryDirectory' "$WT/.claude/settings.local.json")"
eq "settings.local.json preserves pre-existing keys" "Bash(echo:*)" \
  "$(jq -r '.permissions.allow[0]' "$WT/.claude/settings.local.json")"

echo "== memory =="
ok ".agents/memory is a symlink"  test -L "$WT/.agents/memory"
eq ".agents/memory target" "$MEMORY" "$(readlink "$WT/.agents/memory")"
ok "the shared memory dir exists" test -d "$MEMORY"

echo "== codex TOML =="
for t in "$WT"/.codex/config.toml "$WT"/.codex/agents/*.toml; do
  ok "$(basename "$t") parses as TOML" python3 -c \
    'import sys,tomllib; tomllib.load(open(sys.argv[1],"rb"))' "$t"
done
for f in "$WT"/agents/*.md; do
  n="$(basename "$f" .md)"
  toml="$WT/.codex/agents/$n.toml"
  ok "agents/$n.md -> .codex/agents/$n.toml" test -f "$toml"
  [ -f "$toml" ] || continue
  eq "$n: name"                 "$n"  "$(tomlq "$toml" 'd["name"]')"
  ok "$n: description non-empty" test -n "$(tomlq "$toml" 'd["description"]')"
  # developer_instructions must be the markdown body verbatim, with `](../` collapsed to `](`.
  want="$(python3 -c '
import re,sys
text = open(sys.argv[1], encoding="utf-8").read()
body = re.match(r"\A---\r?\n.*?\r?\n---[ \t]*\r?\n", text, re.DOTALL)
body = text[body.end():]
sys.stdout.write(re.sub(r"\]\(\.\./", "](", body).lstrip("\n").rstrip() + "\n")
' "$f")"
  eq "$n: developer_instructions == source body" "$want" "$(tomlq "$toml" 'd["developer_instructions"]')"
  eq "$n: registered in config.toml" "$WT/.codex/agents/$n.toml" \
    "$(tomlq "$WT/.codex/config.toml" "d['agents']['$n']['config_file']")"
done
eq "writable_roots contains the shared memory dir" "True" \
  "$(tomlq "$WT/.codex/config.toml" "'$MEMORY' in d['sandbox_workspace_write']['writable_roots']")"

# The main checkout is the opposite case: its memory dir is INSIDE the workspace, and declaring an
# in-workspace path writable makes codex-cli 0.132.0 bind-mount it read-only over the checkout —
# every sandboxed command there then fails with `bwrap: … Read-only file system`. $WT cannot stand
# in for a main checkout (its .agents/memory is a symlink pointing OUT of it), so the generator is
# run once against a scratch dir shaped like one: repo == main, with a real memory dir inside it.
MAINLIKE="$TMP/mainlike"
mkdir -p "$MAINLIKE/.agents/memory"
python3 "$WT/scripts/gen-codex-config.py" "$MAINLIKE" "$MAINLIKE" > /dev/null 2>&1
eq "generator exits 0 for a main-shaped checkout" 0 "$?"
ok "…and its .codex/config.toml parses"       python3 -c \
  'import sys,tomllib; tomllib.load(open(sys.argv[1],"rb"))' "$MAINLIKE/.codex/config.toml"
eq "…with no sandbox_workspace_write table"    "False" \
  "$(tomlq "$MAINLIKE/.codex/config.toml" "'sandbox_workspace_write' in d")"
ok "…and a comment saying why"                grep -q 'read-only' "$MAINLIKE/.codex/config.toml"

echo "== worktree /.mcp.json =="
if [ -f "$MAIN/.mcp.json" ]; then
  ok "a worktree gets a symlink to the main checkout's /.mcp.json" test -L "$WT/.mcp.json"
  eq "…pointing at the main checkout" "$MAIN/.mcp.json" "$(readlink "$WT/.mcp.json")"
  ok "…and the generator picked it up" grep -q '^\[mcp_servers\.' "$WT/.codex/config.toml"
else
  echo "  (skipped: the main checkout has no /.mcp.json to link)" >&2
fi

# rm FIRST: writing to the path would follow the symlink and overwrite the main checkout's file.
rm -f "$WT/.mcp.json"
# A synthetic real file, covering every transport the generator claims to handle.
cat > "$WT/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest", "--headless"],
      "env": {}
    },
    "demo-env": { "command": "node", "args": ["server.js"], "env": { "API_MODE": "test", "TOKEN": "${DEMO_TOKEN}" } },
    "demo-http": {
      "type": "http",
      "url": "https://example.invalid/mcp",
      "headers": { "Authorization": "Bearer ${DEMO_TOKEN}", "X-Extra": "1" }
    },
    "demo-sse": { "type": "sse", "url": "https://example.invalid/sse" },
    "demo-weird": { "type": "carrier-pigeon", "url": "https://example.invalid/nope" }
  }
}
JSON
env HOME="$FAKEHOME_RO" bash "$WT/scripts/install-agent-config.sh" > "$TMP/install-mcp.log" 2>&1
eq "re-install over a real /.mcp.json exits 0" 0 "$?"
ok "a real /.mcp.json is never replaced by a symlink" test ! -L "$WT/.mcp.json"
ok "…and its content is untouched"                   grep -q 'carrier-pigeon' "$WT/.mcp.json"

echo "== codex mcp_servers =="
CFG="$WT/.codex/config.toml"
eq "chrome-devtools command"   "npx"  "$(tomlq "$CFG" "d['mcp_servers']['chrome-devtools']['command']")"
eq "chrome-devtools args[0]"   "chrome-devtools-mcp@latest" \
  "$(tomlq "$CFG" "d['mcp_servers']['chrome-devtools']['args'][0]")"
eq "an empty env table is omitted" "False" \
  "$(tomlq "$CFG" "'env' in d['mcp_servers']['chrome-devtools']")"
eq "demo-env env table"        "test" "$(tomlq "$CFG" "d['mcp_servers']['demo-env']['env']['API_MODE']")"
eq "http Bearer -> bearer_token_env_var" "DEMO_TOKEN" \
  "$(tomlq "$CFG" "d['mcp_servers']['demo-http']['bearer_token_env_var']")"
eq "http Authorization header dropped" "False" \
  "$(tomlq "$CFG" "'Authorization' in d['mcp_servers']['demo-http'].get('http_headers', {})")"
eq "other http headers kept"   "1"    "$(tomlq "$CFG" "d['mcp_servers']['demo-http']['http_headers']['X-Extra']")"
eq "sse falls back to a url"   "https://example.invalid/sse" \
  "$(tomlq "$CFG" "d['mcp_servers']['demo-sse']['url']")"
eq "unknown transport skipped" "False" "$(tomlq "$CFG" "'demo-weird' in d['mcp_servers']")"

echo "== generator string escaping =="
# Both branches of toml_string must round-trip through a real TOML parser: the literal `'''…'''`
# form, and the JSON-escaped fallback for bodies that contain `'''` or end in an apostrophe.
ESC="$(python3 - "$WT/scripts/gen-codex-config.py" <<'PY'
import importlib.util, tomllib, sys
spec = importlib.util.spec_from_file_location("g", sys.argv[1])
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
q = chr(39)
cases = ["plain\nbody\n", "tab\there\n", "em dash — here\n", "a\n" + q * 3 + "b\n", "ends\nin" + q]
print("literal" if g.toml_string(cases[0]).startswith(q * 3) else "basic")
print("basic" if not g.toml_string(cases[3]).startswith(q * 3) else "literal")
print(all(tomllib.loads("k = " + g.toml_string(c))["k"] == c for c in cases))
PY
)"
eq "a normal body uses a TOML literal string"    "literal" "$(sed -n 1p <<< "$ESC")"
eq "a body containing ''' falls back to escaped" "basic"   "$(sed -n 2p <<< "$ESC")"
eq "every form round-trips through tomllib"      "True"    "$(sed -n 3p <<< "$ESC")"

GENERR="$TMP/gen.err"
python3 "$WT/scripts/gen-codex-config.py" "$WT" "$MAIN" > /dev/null 2> "$GENERR"
ok "generator warns about \${VAR}"          grep -q 'does not expand' "$GENERR"
ok "generator warns about sse"              grep -q 'sse' "$GENERR"
ok "generator warns about unknown type"     grep -q 'unknown transport' "$GENERR"

echo "== codex hook =="
HOOKS="$WT/.codex/hooks.json"
eq "hooks.json has exactly one guard entry" 1 \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("claude-guard-bash"))] | length' "$HOOKS")"
eq "hooks.json matcher" "^Bash$" \
  "$(jq -r '[.hooks.PreToolUse[] | select(.hooks[].command | test("claude-guard-bash"))][0].matcher' "$HOOKS")"
eq "hooks.json command resolves the repo root at hook time" \
  '"$(git rev-parse --show-toplevel)"/scripts/claude-guard-bash.sh' \
  "$(jq -r '[.hooks.PreToolUse[].hooks[] | select(.command | test("claude-guard-bash"))][0].command' "$HOOKS")"

echo "== idempotency =="
snapshot() { (
  cd "$1" || exit 1
  find .claude .agents .codex .mcp.json -printf '%p %y %l\n' 2>/dev/null | LC_ALL=C sort
  find .claude .agents .codex .mcp.json -type f -printf '%p\n' 2>/dev/null | LC_ALL=C sort \
    | xargs -r sha256sum
) }
snapshot "$WT" > "$TMP/snap1"
env HOME="$FAKEHOME_RO" bash "$WT/scripts/install-agent-config.sh" > "$TMP/install2.log" 2>&1
eq "second run exits 0" 0 "$?"
snapshot "$WT" > "$TMP/snap2"
if diff -u "$TMP/snap1" "$TMP/snap2" > "$TMP/snap.diff"; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf 'FAIL  second install changed the tree:\n' >&2; sed -n '1,40p' "$TMP/snap.diff" >&2
fi

echo "== zero-byte settings and hooks files =="
# `jq '.x = $v'` on a ZERO-BYTE file runs the filter zero times, prints nothing and exits 0, so a
# `-f` existence test plus tmp+mv silently truncates the file and drops the key.
git -C "$REPO" worktree add --detach "$WT3" HEAD >/dev/null 2>&1 || die "git worktree add wt3"
cp -a "$REPO/scripts/." "$WT3/scripts/" || die "copy scripts"
mkdir -p "$WT3/.claude" "$WT3/.codex"
: > "$WT3/.claude/settings.json"
: > "$WT3/.claude/settings.local.json"
: > "$WT3/.codex/hooks.json"
env HOME="$FAKEHOME_RO" bash "$WT3/scripts/install-agent-config.sh" > "$TMP/empty.log" 2>&1
eq "install over zero-byte JSON exits 0" 0 "$?"
eq "0-byte settings.local.json still gets autoMemoryDirectory" "$MEMORY" \
  "$(jq -r '.autoMemoryDirectory' "$WT3/.claude/settings.local.json" 2>/dev/null)"
eq "0-byte settings.json still gets exactly one guard hook" 1 \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("claude-guard-bash"))] | length' \
      "$WT3/.claude/settings.json" 2>/dev/null)"
eq "0-byte .codex/hooks.json still gets exactly one guard hook" 1 \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("claude-guard-bash"))] | length' \
      "$WT3/.codex/hooks.json" 2>/dev/null)"

echo "== preflight: a stray .codex FILE =="
git -C "$REPO" worktree add --detach "$WT2" HEAD >/dev/null 2>&1 || die "git worktree add wt2"
cp -a "$REPO/scripts/." "$WT2/scripts/" || die "copy scripts"
: > "$WT2/.codex"
env HOME="$FAKEHOME_RO" bash "$WT2/scripts/install-agent-config.sh" > "$TMP/pre.log" 2>&1
eq "installer refuses a non-directory .codex" 1 "$?"
ok "…and says why" grep -q 'stray file' "$TMP/pre.log"

echo "== --user (hermetic: fake HOME + stub codex) =="
FAKEHOME="$TMP/home"
mkdir -p "$FAKEHOME/.claude" "$FAKEHOME/.codex" "$TMP/bin"
printf '# user rules\n' > "$FAKEHOME/.claude/CLAUDE.md"
cat > "$FAKEHOME/.claude.json" <<'JSON'
{"mcpServers": {
  "chrome-devtools": {"type":"stdio","command":"npx","args":["chrome-devtools-mcp@latest","--headless"],"env":{"A":"b"}},
  "already-there": {"type":"stdio","command":"node","args":["x.js"]},
  "remote-thing": {"type":"http","url":"https://example.invalid/mcp"}
}}
JSON
printf '[mcp_servers.already-there]\ncommand = "node"\n' > "$FAKEHOME/.codex/config.toml"
cat > "$TMP/bin/codex" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CODEX_STUB_LOG"
SH
chmod +x "$TMP/bin/codex"
STUB_LOG="$TMP/codex-argv.log"
: > "$STUB_LOG"
env HOME="$FAKEHOME" CODEX_STUB_LOG="$STUB_LOG" PATH="$TMP/bin:$PATH" \
  bash "$WT/scripts/install-agent-config.sh" --user > "$TMP/user.log" 2>&1
eq "--user run exits 0" 0 "$?"
eq "~/.codex/AGENTS.md -> ~/.claude/CLAUDE.md" "$FAKEHOME/.claude/CLAUDE.md" \
  "$(readlink "$FAKEHOME/.codex/AGENTS.md")"
eq "stub codex was called once per missing server" 2 "$(wc -l < "$STUB_LOG")"
ok "stdio server added with --env and a -- separator" \
  grep -qxF 'mcp add chrome-devtools --env A=b -- npx chrome-devtools-mcp@latest --headless' "$STUB_LOG"
ok "http server added with --url" \
  grep -qxF 'mcp add remote-thing --url https://example.invalid/mcp' "$STUB_LOG"
ok "a server already in ~/.codex/config.toml is not re-added" \
  bash -c '! grep -q "already-there" "$1"' _ "$STUB_LOG"

echo
if [ "$fail" -eq 0 ]; then
  echo "install self-test: $pass checks passed, 0 failures"
else
  echo "install self-test: $pass passed, $fail FAILED" >&2
  exit 1
fi
