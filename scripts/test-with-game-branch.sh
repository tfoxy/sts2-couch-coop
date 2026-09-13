#!/usr/bin/env bash
# Self-test for scripts/with-game-branch.sh.
#
# Hermetic. Everything happens in a THROWAWAY repo-shaped directory under mktemp -d, holding a copy
# of the working tree's scripts/ and the four committed config files, plus TWO synthetic game
# installs. No real game install is read or written, the real .sts2/branches registry is never
# touched, and the checkout you run this from is not modified.
#
# A synthetic install is a release_info.json, a data_sts2_fake_x86_64/ holding sts2.dll AND
# GodotSharp.dll, a real SlayTheSpire2 file, steam_appid.txt and an empty mods/. Both DLL stubs
# matter: the sts2 CLI only accepts a directory as an install root when a data_sts2_* subdirectory
# holds both, and when it does not it falls back to Steam autodiscovery instead of failing --
# which is the whole trap with-game-branch.sh exists to catch.

# Single-quoted `bash -c` bodies below take their paths as positional arguments on purpose, so the
# quoting survives a path with spaces; SC2016 flags every one of them.
# shellcheck disable=SC2016

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"
SCRIPT_SRC="$REPO/scripts/with-game-branch.sh"

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
no() { # no <desc> <cmd…>  -- the command must FAIL
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then fail=$((fail+1)); printf 'FAIL  %s (expected failure, got success)\n' "$desc" >&2
  else pass=$((pass+1)); fi
}
die() { printf 'setup failed: %s\n' "$1" >&2; exit 1; }

TMP="$(mktemp -d)" || die "mktemp"
trap 'rm -rf "$TMP"' EXIT

WBR="$TMP/repo/scripts/with-game-branch.sh"
SCRATCH="$TMP/scratch-mods"

# A run form wrapped so no ambient value of the variables under test can mask a missing export.
run() { # run <branch> -- <cmd…>
  env -u SPIRECTL_CONFIG_DIR -u STS2_ASSEMBLIES_DIR -u CouchCoopLocalConfigPath \
      -u COUCHCOOP_LOCAL_MOD_DIR -u COUCHCOOP_GAME_MODS_DIR -u SPIRECTL_INSTANCE \
      bash "$WBR" "$@"
}

make_install() { # make_install <dir> <version> <commit> <branch>
  local d="$1"
  mkdir -p "$d/data_sts2_fake_x86_64" "$d/mods" || return 1
  : > "$d/data_sts2_fake_x86_64/sts2.dll"
  : > "$d/data_sts2_fake_x86_64/GodotSharp.dll"
  : > "$d/SlayTheSpire2"
  chmod +x "$d/SlayTheSpire2"
  printf '2868840' > "$d/steam_appid.txt"
  printf '{\n  "commit": "%s",\n  "version": "%s",\n  "date": "2026-09-01T00:00:00-07:00",\n  "branch": "%s",\n  "main_assembly_hash": 1\n}' \
    "$3" "$2" "$4" > "$d/release_info.json"
}

# ---------------------------------------------------------------------------------------------
# The throwaway repo.
# ---------------------------------------------------------------------------------------------
TREPO="$TMP/repo"
mkdir -p "$TREPO/scripts" || die "mkdir"
cp "$SCRIPT_SRC" "$TREPO/scripts/" || die "copy the script under test"
for f in sts2.config.yaml sts2.profiles.yaml sts2.hooks.yaml sts2.hot-reload.yaml; do
  cp "$REPO/$f" "$TREPO/$f" || die "copy $f"
done
STABLE="$TMP/install-stable"
BETA="$TMP/install-beta"
make_install "$STABLE" v0.107.1 aaaa1111 v0.107.1 || die "stable install"
make_install "$BETA"   v0.108.0 bbbb2222 beta     || die "beta install"
printf 'game:\n  path: "%s"\n  assembliesDir: "%s/data_sts2_fake_x86_64"\n' "$STABLE" "$STABLE" \
  > "$TREPO/sts2.local.yaml"
mkdir -p "$SCRATCH"
# Mirror the real checkout's layout: .sts2/toolchain is a SYMLINK to the sibling spirectl repo's
# decompile corpus. The shared-corpus checks below compare the symlink path, which is how a branch
# config would ever spell it; a config naming spirectl's corpus by its real path is not caught, and
# is not a mistake anybody makes by omission.
SPIRECTL_CORPUS="$TMP/spirectl-corpus"
mkdir -p "$SPIRECTL_CORPUS/decompile" "$TREPO/.sts2"
ln -s "$SPIRECTL_CORPUS" "$TREPO/.sts2/toolchain"

BETA_CFG="$TREPO/.sts2/branches/beta"

echo "== setup =="
SETUP_LOG="$TMP/setup.log"
bash "$WBR" setup beta --game-path "$BETA" > "$SETUP_LOG" 2>&1
eq "setup exits 0" 0 "$?"
ok "branch dir exists"                    test -d "$BETA_CFG"
ok "…with a REAL sts2.local.yaml"         test -f "$BETA_CFG/sts2.local.yaml"
ok "…that is not a symlink"               test ! -L "$BETA_CFG/sts2.local.yaml"
for f in sts2.config.yaml sts2.profiles.yaml sts2.hooks.yaml sts2.hot-reload.yaml; do
  ok "$f is a symlink"                    test -L "$BETA_CFG/$f"
  eq "$f points at the repo root" "$TREPO/$f" "$(readlink "$BETA_CFG/$f")"
  ok "…and resolves"                      test -e "$BETA_CFG/$f"
done
ok "the recorded build identity is copied" test -f "$BETA_CFG/recorded-release-info.json"
ok "…byte-identical to the install's"      cmp -s "$BETA_CFG/recorded-release-info.json" "$BETA/release_info.json"
ok "setup prints the build identity"       grep -q 'v0.108.0' "$SETUP_LOG"

echo "== the generated branch sts2.local.yaml =="
ok "carries game.path"        grep -qF "path: \"$BETA\"" "$BETA_CFG/sts2.local.yaml"
ok "carries game.assembliesDir" \
  grep -qF "assembliesDir: \"$BETA/data_sts2_fake_x86_64\"" "$BETA_CFG/sts2.local.yaml"
# Pinned absolute, because sts2 resolves a profile/hook relative command, its cwd and ${profileDir}
# against the directory holding the profiles/hooks FILE -- the branch dir, if left to the symlink.
ok "pins project.profilesFile at the repo root" \
  grep -qF "profilesFile: \"$TREPO/sts2.profiles.yaml\"" "$BETA_CFG/sts2.local.yaml"
ok "pins project.hooksFile at the repo root" \
  grep -qF "hooksFile: \"$TREPO/sts2.hooks.yaml\"" "$BETA_CFG/sts2.local.yaml"
# A branch keeps its own save state. The CACHE is no longer a reason for this — it is branch scoped at
# user://couch-coop/cache/<branch>/ and stamped with the build that wrote it — and the generated comment
# has to say so, or the next reader copies a warning that stopped being true.
ok "leaves instances.symlinkUserDataDirs empty" \
  grep -qE '^[[:space:]]*symlinkUserDataDirs:[[:space:]]*\[\][[:space:]]*$' "$BETA_CFG/sts2.local.yaml"
ok "…and says why"            grep -q 'couch-coop/cache/<branch>' "$BETA_CFG/sts2.local.yaml"

echo "== the branch corpus is pinned away from the shared one =="
# `sts2 project recover --kind decompile` rewrites <toolchain.dir>/decompile/, and toolchain.dir
# DEFAULTS to a relative `.sts2/toolchain` anchored on the directory the CLI picked -- this branch
# dir under SPIRECTL_CONFIG_DIR, but the WORKING directory under `sts2 --config <file>`, where it
# lands on spirectl's shared corpus. Verified by running `project recover` against throwaway
# configs and watching where <toolchain.dir>/manifests appeared.
ok "the toolchain.dir line is exactly as expected" \
  grep -qF "  dir: \"$TREPO/.sts2/toolchain-beta\"" "$BETA_CFG/sts2.local.yaml"
TC="$(awk '/^toolchain:/{b=1;next} /^[^[:space:]#]/{b=0} b && /^[[:space:]]+dir:/{sub(/^[[:space:]]+dir:[[:space:]]*/,"");gsub(/"/,"");print;exit}' "$BETA_CFG/sts2.local.yaml")"
eq "toolchain.dir is <repo>/.sts2/toolchain-<branch>" "$TREPO/.sts2/toolchain-beta" "$TC"
ok "…absolute"                           bash -c 'case "$1" in /*) exit 0 ;; *) exit 1 ;; esac' _ "$TC"
ok "…is NOT .sts2/toolchain"             bash -c '[ "$1" != "$2/.sts2/toolchain" ]' _ "$TC" "$TREPO"
ok "…is NOT inside .sts2/toolchain"      bash -c 'case "$1" in "$2/.sts2/toolchain/"*) exit 1 ;; *) exit 0 ;; esac' _ "$TC" "$TREPO"
ok "…is NOT inside the branch directory" bash -c 'case "$1" in "$2"*) exit 1 ;; *) exit 0 ;; esac' _ "$TC" "$BETA_CFG"
# The repo-root config names no toolchain.dir, so stable resolves to the shared symlink. A branch
# that resolved to the same path is the expensive mistake this pin exists to prevent.
ok "…is NOT what the repo-root config resolves to" \
  bash -c '[ "$1" != "$2/.sts2/toolchain" ]' _ "$TC" "$TREPO"
ok "…and the file says why it must not be the shared corpus" \
  grep -q 'spirectl' "$BETA_CFG/sts2.local.yaml"
ok "setup reports the corpus"            grep -qF "corpus       $TREPO/.sts2/toolchain-beta" "$SETUP_LOG"
# The generated layout has to match the corpora produced by hand before this script existed
# (.sts2/toolchain-public, .sts2/toolchain-public-beta), or `setup public-beta` orphans one. Assert
# it by registering that exact branch name and reading back what the file says.
PB="$TMP/install-public-beta"
make_install "$PB" v0.111.0 41cef1ea public-beta || die "public-beta install"
bash "$WBR" setup public-beta --game-path "$PB" >/dev/null 2>&1 || die "setup public-beta"
PBTC="$(awk '/^toolchain:/{b=1;next} /^[^[:space:]#]/{b=0} b && /^[[:space:]]+dir:/{sub(/^[[:space:]]+dir:[[:space:]]*/,"");gsub(/"/,"");print;exit}' \
  "$TREPO/.sts2/branches/public-beta/sts2.local.yaml")"
eq "setup public-beta names .sts2/toolchain-public-beta" "$TREPO/.sts2/toolchain-public-beta" "$PBTC"

echo "== the corpus warnings =="
# Not fatal: only `project recover` writes a corpus, and refusing every other command over it would
# be wrong. But a hand-written branch config that omits toolchain.dir must be told, every run.
NOTC="$TREPO/.sts2/branches/notc"
mkdir -p "$NOTC"
printf 'game:\n  path: "%s"\n  assembliesDir: "%s/data_sts2_fake_x86_64"\n' "$BETA" "$BETA" \
  > "$NOTC/sts2.local.yaml"
run notc -- true > /dev/null 2> "$TMP/notc.log"
eq "a branch with no toolchain.dir still RUNS" 0 "$?"
ok "…but warns"                        grep -q 'sets no toolchain.dir' "$TMP/notc.log"
ok "…naming the nested path it would use" grep -qF "$NOTC/.sts2/toolchain" "$TMP/notc.log"
ok "…and the value to add"              grep -qF "dir: $TREPO/.sts2/toolchain-notc" "$TMP/notc.log"
# Pointed squarely at spirectl's shared corpus: the expensive mistake, stated as such.
SHARED="$TREPO/.sts2/branches/shared"
mkdir -p "$SHARED"
printf 'game:\n  path: "%s"\n  assembliesDir: "%s/data_sts2_fake_x86_64"\ntoolchain:\n  dir: "%s/.sts2/toolchain"\n' \
  "$BETA" "$BETA" "$TREPO" > "$SHARED/sts2.local.yaml"
run shared -- true > /dev/null 2> "$TMP/shared.log"
eq "a branch pointed at the shared corpus still RUNS" 0 "$?"
ok "…but warns it is the shared corpus" grep -q 'SHARED with the spirectl repo' "$TMP/shared.log"
ok "…and offers the right path"         grep -qF "$TREPO/.sts2/toolchain-shared" "$TMP/shared.log"
# A correctly pinned branch says nothing.
run beta -- true > /dev/null 2> "$TMP/beta-quiet.log"
ok "a pinned branch raises no corpus warning" \
  bash -c '! grep -q "WARNING" "$1"' _ "$TMP/beta-quiet.log"
ok "…and the banner still reports the corpus" \
  grep -qF "corpus       $TREPO/.sts2/toolchain-beta" "$TMP/beta-quiet.log"

echo '== the block reader does not confuse another block dir key =='
# A bare `dir` key is generic; game.dir / project.dir must never be read as toolchain.dir.
DECOY="$TREPO/.sts2/branches/decoy"
mkdir -p "$DECOY"
printf 'game:\n  path: "%s"\n  assembliesDir: "%s/data_sts2_fake_x86_64"\n  dir: /decoy/game\nproject:\n  dir: /decoy/project\ntoolchain:\n  dir: "%s/.sts2/toolchain-decoy"\n' \
  "$BETA" "$BETA" "$TREPO" > "$DECOY/sts2.local.yaml"
run decoy -- true > /dev/null 2> "$TMP/decoy.log"
eq "a decoy dir key does not break the run" 0 "$?"
ok "the corpus comes from the toolchain block" \
  grep -qF "corpus       $TREPO/.sts2/toolchain-decoy" "$TMP/decoy.log"
ok "…and not from game.dir"    bash -c '! grep -q "/decoy/game" "$1"' _ "$TMP/decoy.log"
ok "…and not from project.dir" bash -c '! grep -q "/decoy/project" "$1"' _ "$TMP/decoy.log"

echo "== --force does not silently drop a hand-set toolchain.dir =="
HAND="$TREPO/.sts2/branches/hand"
mkdir -p "$HAND"
printf 'game:\n  path: "%s"\n  assembliesDir: "%s/data_sts2_fake_x86_64"\ntoolchain:\n  dir: "%s/hand-corpus"\n' \
  "$BETA" "$BETA" "$TMP" > "$HAND/sts2.local.yaml"
bash "$WBR" setup hand --game-path "$BETA" --force > "$TMP/hand.log" 2>&1
eq "setup --force over a hand-written file exits 0" 0 "$?"
ok "the previous file is kept"          test -f "$HAND/sts2.local.yaml.replaced"
ok "…with its original toolchain.dir"   grep -qF "$TMP/hand-corpus" "$HAND/sts2.local.yaml.replaced"
ok "…and setup says where it went"      grep -qF "replaced     $HAND/sts2.local.yaml.replaced" "$TMP/hand.log"
ok "…and warns that the value changed"  grep -q 'replacing a hand-set toolchain.dir' "$TMP/hand.log"
ok "…showing both values"               grep -qF "was  $TMP/hand-corpus" "$TMP/hand.log"
ok "the generated header warns --force loses hand-added keys" \
  grep -q 'REWRITES IT FROM SCRATCH' "$HAND/sts2.local.yaml"

echo "== setup refusals =="
no "setup refuses 'stable'"           bash "$WBR" setup stable --game-path "$BETA"
no "setup refuses 'default'"          bash "$WBR" setup default --game-path "$BETA"
ok "…naming the repo root file"       bash -c 'bash "$1" setup stable --game-path "$2" 2>&1 | grep -q "sts2.local.yaml"' _ "$WBR" "$BETA"
no "setup refuses a path traversal"   bash "$WBR" setup '../evil' --game-path "$BETA"
no "setup refuses a slash"            bash "$WBR" setup 'a/b' --game-path "$BETA"
no "setup refuses a missing --game-path" bash "$WBR" setup other
no "setup refuses a non-install dir"  bash "$WBR" setup other --game-path "$TMP"
no "setup refuses stable's own install" bash "$WBR" setup dupe --game-path "$STABLE"
no "setup refuses re-registering"     bash "$WBR" setup beta --game-path "$BETA"
ok "…and says --force"                bash -c 'bash "$1" setup beta --game-path "$2" 2>&1 | grep -q -- "--force"' _ "$WBR" "$BETA"
ok "--force re-registers"             bash "$WBR" setup beta --game-path "$BETA" --force
ok "a path-traversal name writes nothing" test ! -e "$TREPO/.sts2/evil" -a ! -e "$TMP/evil"

echo "== setup requires a REAL install root =="
# The CLI accepts an install root only when a data_sts2_* dir holds sts2.dll AND GodotSharp.dll.
HALF="$TMP/install-half"
make_install "$HALF" v0.109.0 cccc3333 half || die "half install"
rm "$HALF/data_sts2_fake_x86_64/GodotSharp.dll"
no "setup refuses an install with no GodotSharp.dll" bash "$WBR" setup half --game-path "$HALF"
ok "…naming both required assemblies" \
  bash -c 'bash "$1" setup half --game-path "$2" 2>&1 | grep -q "GodotSharp.dll"' _ "$WBR" "$HALF"

echo "== the run form exports both resolvers' inputs =="
ENVOUT="$TMP/env.txt"
run beta -- env > "$ENVOUT" 2>"$TMP/env.err"
eq "run exits 0" 0 "$?"
ok "SPIRECTL_CONFIG_DIR -> the branch config dir" \
  grep -qxF "SPIRECTL_CONFIG_DIR=$BETA_CFG" "$ENVOUT"
ok "STS2_ASSEMBLIES_DIR -> the branch assemblies" \
  grep -qxF "STS2_ASSEMBLIES_DIR=$BETA/data_sts2_fake_x86_64" "$ENVOUT"
ok "CouchCoopLocalConfigPath -> the branch sts2.local.yaml" \
  grep -qxF "CouchCoopLocalConfigPath=$BETA_CFG/sts2.local.yaml" "$ENVOUT"
ok "COUCHCOOP_LOCAL_MOD_DIR -> the branch install's mod dir" \
  grep -qxF "COUCHCOOP_LOCAL_MOD_DIR=$BETA/mods/couchcoop" "$ENVOUT"
ok "SPIRECTL_INSTANCE -> the branch name" grep -qxF "SPIRECTL_INSTANCE=beta" "$ENVOUT"
# XDG_DATA_HOME redirects far more than the game's Godot user dir; --instance is the narrow knob.
ok "XDG_DATA_HOME is NOT set by the wrapper" \
  bash -c '! grep -q "^XDG_DATA_HOME=" "$1"' _ "$ENVOUT"
ok "the banner names the resolved install" grep -qF "$BETA" "$TMP/env.err"
ok "the banner names the build identity"   grep -q 'v0.108.0' "$TMP/env.err"
ok "the banner goes to stderr, not stdout" bash -c '! grep -q "with-game-branch:" "$1"' _ "$ENVOUT"

echo "== the run form is transparent =="
eq "argv survives spaces" "a b|c" \
  "$(run beta -- bash -c 'printf "%s|" "$@"; echo' _ 'a b' c 2>/dev/null | sed 's/|$//')"
run beta -- sh -c 'exit 7' >/dev/null 2>&1
eq "the command's exit code is passed through" 7 "$?"
no "the run form requires a '--'"    run beta env
ok "…and says so"                    bash -c 'run() { bash "$1" "${@:2}"; }; run "$1" beta env 2>&1 | grep -q -- "--"' _ "$WBR"
no "the run form needs a command after '--'" run beta --
no "a mistyped flag is not a branch name" bash "$WBR" --nope -- true
ok "…and is named as an unknown option" \
  bash -c 'bash "$1" --nope -- true 2>&1 | grep -q "unknown option"' _ "$WBR"

echo "== stable =="
SENV="$TMP/stable-env.txt"
run stable -- env > "$SENV" 2>"$TMP/stable.err"
eq "stable run exits 0" 0 "$?"
ok "stable's config dir is the repo root" grep -qxF "SPIRECTL_CONFIG_DIR=$TREPO" "$SENV"
ok "stable's local config is the repo root's" \
  grep -qxF "CouchCoopLocalConfigPath=$TREPO/sts2.local.yaml" "$SENV"
ok "stable resolves the stable install" grep -qxF "STS2_ASSEMBLIES_DIR=$STABLE/data_sts2_fake_x86_64" "$SENV"
ok "stable does NOT set SPIRECTL_INSTANCE" bash -c '! grep -q "^SPIRECTL_INSTANCE=" "$1"' _ "$SENV"
# Stable IS the shared corpus, and that is correct: it is built from the stable game. Labelled, so
# nobody reads the branch warnings above and "fixes" this one.
ok "stable's corpus is the shared .sts2/toolchain" \
  grep -qF "corpus       $TREPO/.sts2/toolchain" "$TMP/stable.err"
ok "…labelled as shared and correct" grep -q 'shared with spirectl; correct for stable' "$TMP/stable.err"
ok "…and stable raises no corpus warning" \
  bash -c '! grep -q "WARNING" "$1"' _ "$TMP/stable.err"
ok "'default' is an alias for stable" \
  bash -c 'bash "$1" default -- env 2>/dev/null | grep -qxF "SPIRECTL_CONFIG_DIR=$2"' _ "$WBR" "$TREPO"

echo "== overrides the wrapper must not stomp =="
ok "an already-set SPIRECTL_INSTANCE is kept" \
  bash -c 'SPIRECTL_INSTANCE=mine bash "$1" beta -- env 2>/dev/null | grep -qxF "SPIRECTL_INSTANCE=mine"' _ "$WBR"
# COUCHCOOP_LOCAL_MOD_DIR outranks COUCHCOOP_GAME_MODS_DIR in Directory.Build.props, so deriving it
# from the install would defeat the scratch-dir valve every worktree build depends on.
ok "a scratch COUCHCOOP_GAME_MODS_DIR still wins the mod output" \
  bash -c 'COUCHCOOP_GAME_MODS_DIR="$2" bash "$1" beta -- env 2>/dev/null | grep -qxF "COUCHCOOP_LOCAL_MOD_DIR=$2/couchcoop"' \
  _ "$WBR" "$SCRATCH"
ok "an explicit COUCHCOOP_LOCAL_MOD_DIR is kept" \
  bash -c 'COUCHCOOP_LOCAL_MOD_DIR="$2/explicit" bash "$1" beta -- env 2>/dev/null | grep -qxF "COUCHCOOP_LOCAL_MOD_DIR=$2/explicit"' \
  _ "$WBR" "$SCRATCH"

echo "== an unregistered branch fails with the setup command =="
UNREG="$TMP/unreg.log"
run nosuchbranch -- env > "$TMP/unreg.out" 2> "$UNREG"
eq "an unregistered branch exits non-zero" 1 "$?"
ok "…says it is not registered"      grep -q "not registered" "$UNREG"
ok "…names the setup command to run" grep -q 'setup nosuchbranch --game-path' "$UNREG"
ok "…lists what IS registered"       grep -q 'beta' "$UNREG"
ok "…and never runs the command"     bash -c '! test -s "$1"' _ "$TMP/unreg.out"

echo "== a registry pointing at a vanished install fails, never falls back =="
GONE="$TMP/install-gone"
make_install "$GONE" v0.110.0 dddd4444 gone || die "gone install"
bash "$WBR" setup gone --game-path "$GONE" >/dev/null 2>&1 || die "setup gone"
rm -rf "$GONE"
MARK="$TMP/should-not-exist"
run gone -- touch "$MARK" > /dev/null 2> "$TMP/gone.log"
eq "a vanished install exits non-zero" 1 "$?"
ok "…and the command never ran"       test ! -e "$MARK"
ok "…and it never reports the stable install" \
  bash -c '! grep -qF "$2" "$1"' _ "$TMP/gone.log" "$STABLE"

echo "== a half-populated install fails rather than retargeting =="
# Same install root, still present, but no longer valid: GodotSharp.dll is gone. This is the shape
# a branch download in progress has, and the shape that makes the CLI resolve Steam's install.
PART="$TMP/install-partial"
make_install "$PART" v0.111.0 eeee5555 partial || die "partial install"
bash "$WBR" setup partial --game-path "$PART" >/dev/null 2>&1 || die "setup partial"
rm "$PART/data_sts2_fake_x86_64/GodotSharp.dll"
MARK2="$TMP/should-not-exist-2"
run partial -- touch "$MARK2" > /dev/null 2> "$TMP/partial.log"
eq "a half-populated install exits non-zero" 1 "$?"
ok "…and the command never ran"        test ! -e "$MARK2"
ok "…and it names autodiscovery as the cause" grep -qi 'autodiscovery' "$TMP/partial.log"

echo "== a resolver that answers with a different install fails (fault injection) =="
# The half-populated case above is caught by sources.gamePath == "discovered". The path comparison
# is the independent defence -- for a CLI that reports a different install without labelling it
# discovered at all -- so it gets its own leg, with a stub sts2 that does exactly that.
STUBBIN="$TMP/stubbin"
mkdir -p "$STUBBIN"
cat > "$STUBBIN/sts2" <<STUB
#!/usr/bin/env bash
printf '{"gamePath":"%s","assembliesDir":"%s/data_sts2_fake_x86_64","modsDir":"%s/mods","errors":[],"sources":{"gamePath":"local-config"}}\n' \\
  "$STABLE" "$STABLE" "$STABLE"
STUB
chmod +x "$STUBBIN/sts2"
MARK3="$TMP/should-not-exist-3"
PATH="$STUBBIN:$PATH" run beta -- touch "$MARK3" > /dev/null 2> "$TMP/stub.log"
eq "a resolver naming another install exits non-zero" 1 "$?"
ok "…and the command never ran"     test ! -e "$MARK3"
ok "…and both paths are reported"   grep -qF "$BETA" "$TMP/stub.log"
ok "…including the one it resolved" grep -qF "$STABLE" "$TMP/stub.log"

echo "== a branch with no game.path cannot be satisfied by autodiscovery =="
# Hand-edit a branch config down to assembliesDir only. There is now no configured path to compare
# against, so the path check above cannot fire and sources.gamePath is the only signal left. A
# discovered install must still be refused: it is by definition not this branch's.
NOPATH="$TMP/install-nopath"
make_install "$NOPATH" v0.113.0 aaaa7777 nopath || die "nopath install"
bash "$WBR" setup nopath --game-path "$NOPATH" >/dev/null 2>&1 || die "setup nopath"
printf 'game:\n  assembliesDir: "%s/data_sts2_fake_x86_64"\n' "$NOPATH" > "$TREPO/.sts2/branches/nopath/sts2.local.yaml"
cat > "$STUBBIN/sts2" <<STUB
#!/usr/bin/env bash
printf '{"gamePath":"%s","assembliesDir":"%s/data_sts2_fake_x86_64","modsDir":"%s/mods","errors":[],"sources":{"gamePath":"discovered"}}\n' \\
  "$NOPATH" "$NOPATH" "$NOPATH"
STUB
MARK4="$TMP/should-not-exist-4"
PATH="$STUBBIN:$PATH" run nopath -- touch "$MARK4" > /dev/null 2> "$TMP/nopath.log"
eq "a discovered install is refused even when it matches" 1 "$?"
ok "…and the command never ran"  test ! -e "$MARK4"
ok "…and it says autodiscovery"  grep -qi 'autodiscovery' "$TMP/nopath.log"
rm -f "$STUBBIN/sts2"

echo "== the symlink traps =="
# A shared mods/ means each deploy re-points the other install; a symlinked game binary makes Godot
# resolve /proc/self/exe to the other install and load ITS mods/.
LNMODS="$TMP/install-lnmods"
make_install "$LNMODS" v0.112.0 ffff6666 lnmods || die "lnmods install"
bash "$WBR" setup lnmods --game-path "$LNMODS" >/dev/null 2>&1 || die "setup lnmods"
rmdir "$LNMODS/mods" && ln -s "$STABLE/mods" "$LNMODS/mods"
no "a symlinked mods/ fails"           run lnmods -- true
ok "…and says deploys re-point each other" \
  bash -c 'run() { env -u SPIRECTL_INSTANCE bash "$1" "${@:2}"; }; run "$1" lnmods -- true 2>&1 | grep -q "SYMLINK"' _ "$WBR"
rm "$LNMODS/mods" && mkdir "$LNMODS/mods"
rm "$LNMODS/SlayTheSpire2" && ln -s "$STABLE/SlayTheSpire2" "$LNMODS/SlayTheSpire2"
no "a symlinked game binary fails"     run lnmods -- true
ok "…and names /proc/self/exe" \
  bash -c 'run() { env -u SPIRECTL_INSTANCE bash "$1" "${@:2}"; }; run "$1" lnmods -- true 2>&1 | grep -q "proc/self/exe"' _ "$WBR"

echo "== drift warning =="
DRIFT="$TMP/drift.log"
run beta -- true > /dev/null 2> "$DRIFT"
ok "no drift warning before the install changes" bash -c '! grep -qi "DRIFTED" "$1"' _ "$DRIFT"
make_install "$BETA" v0.108.2 bbbb9999 beta || die "beta update"
run beta -- true > /dev/null 2> "$DRIFT"
eq "drift still RUNS the command" 0 "$?"
ok "…and warns"                   grep -qi 'DRIFTED' "$DRIFT"
ok "…showing the recorded identity" grep -q 'v0.108.0' "$DRIFT"
ok "…and the current one"           grep -q 'v0.108.2' "$DRIFT"
bash "$WBR" setup beta --game-path "$BETA" --force >/dev/null 2>&1 || die "re-record beta"
run beta -- true > /dev/null 2> "$DRIFT"
ok "--force re-records and clears the warning" bash -c '! grep -qi "DRIFTED" "$1"' _ "$DRIFT"

echo "== list =="
LIST="$TMP/list.txt"
bash "$WBR" list > "$LIST" 2>&1
eq "list exits 0" 0 "$?"
ok "list shows stable"            grep -q '^stable' "$LIST"
ok "…and its install"             grep -qF "$STABLE" "$LIST"
ok "…and its build identity"      grep -q 'v0.107.1' "$LIST"
ok "list shows a registered branch" grep -q '^beta' "$LIST"
ok "…and its install"             grep -qF "$BETA" "$LIST"
ok "list names each config dir"   grep -qF "$BETA_CFG" "$LIST"
ok "list names each corpus"       grep -qF "corpus $TREPO/.sts2/toolchain-beta" "$LIST"
ok "…including stable's shared one" grep -qF "corpus $TREPO/.sts2/toolchain" "$LIST"
no "list takes no arguments"      bash "$WBR" list beta

echo "== no sts2 CLI: the sed fallback =="
# The shipped mod must never require the CLI, and neither must this. PATH here has no sts2.
BAREPATH="$TMP/bin"
mkdir -p "$BAREPATH"
for t in bash sh sed grep head env cmp cp mkdir ln printf basename dirname chmod rm true touch tr; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BAREPATH/$t"
done
NOCLI="$TMP/nocli.txt"
env -i PATH="$BAREPATH" HOME="$TMP" "$BAREPATH/bash" "$WBR" beta -- env > "$NOCLI" 2> "$TMP/nocli.err"
eq "the run form works with no sts2 on PATH" 0 "$?"
ok "…still exports the branch config dir" grep -qxF "SPIRECTL_CONFIG_DIR=$BETA_CFG" "$NOCLI"
ok "…still exports the branch assemblies" \
  grep -qxF "STS2_ASSEMBLIES_DIR=$BETA/data_sts2_fake_x86_64" "$NOCLI"
ok "…and says which resolver answered"    grep -q 'sed fallback' "$TMP/nocli.err"
# An empty branch config on the fallback path must reach the assertion and say so, not exit
# silently -- a function whose last command fails takes the whole script down under `set -e`.
EMPTYB="$TREPO/.sts2/branches/emptycfg"
mkdir -p "$EMPTYB"
printf '# nothing but a comment\n' > "$EMPTYB/sts2.local.yaml"
env -i PATH="$BAREPATH" HOME="$TMP" "$BAREPATH/bash" "$WBR" emptycfg -- env \
  > "$TMP/empty.out" 2> "$TMP/empty.err"
eq "a branch config with no game.path exits non-zero" 1 "$?"
ok "…with a message, not in silence" test -s "$TMP/empty.err"
ok "…naming game.path"               grep -q 'game.path' "$TMP/empty.err"
ok "…and the command never ran"      bash -c '! test -s "$1"' _ "$TMP/empty.out"

echo "== Directory.Build.props follows CouchCoopLocalConfigPath from the environment =="
# The wrapper sets no -p: flag; it relies on MSBuild surfacing environment variables as properties.
# That claim is load-bearing, so it is pinned here against the REAL Directory.Build.props.
if command -v dotnet >/dev/null 2>&1; then
  PROJ="$REPO/src/CouchCoop.Mod.Contracts/CouchCoop.Mod.Contracts.csproj"
  got="$(env COUCHCOOP_GAME_MODS_DIR="$SCRATCH" CouchCoopLocalConfigPath="$BETA_CFG/sts2.local.yaml" \
    dotnet msbuild "$PROJ" -getProperty:Sts2AssembliesDir 2>/dev/null | tr -d '\r' | tail -n 1)"
  eq "Sts2AssembliesDir follows the env var" "$BETA/data_sts2_fake_x86_64" "$got"
  base="$(env COUCHCOOP_GAME_MODS_DIR="$SCRATCH" \
    dotnet msbuild "$PROJ" -getProperty:Sts2AssembliesDir 2>/dev/null | tr -d '\r' | tail -n 1)"
  ok "…and does not without it" bash -c '[ "$1" != "$2" ]' _ "$base" "$BETA/data_sts2_fake_x86_64"
else
  echo "  (skipped: no dotnet on PATH)" >&2
fi

echo "== the real registry was not touched =="
ok "no branch was written into this checkout's .sts2/branches" \
  bash -c '! test -e "$1/.sts2/branches/beta"' _ "$REPO"

echo
if [ "$fail" -eq 0 ]; then
  echo "with-game-branch self-test: $pass checks passed, 0 failures"
else
  echo "with-game-branch self-test: $pass passed, $fail FAILED" >&2
  exit 1
fi
