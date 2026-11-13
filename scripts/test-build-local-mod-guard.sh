#!/usr/bin/env bash
# Hermetic build/deploy guard checks: copied scripts, fake installs and stubbed build tools only.
set -uo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "test-build-local-mod-guard: jq is required" >&2; exit 1; }

pass=0; fail=0
eq() {
  if [[ "$2" == "$3" ]]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$2" "$3" >&2; fi
}
ok() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  %s\n' "$desc" >&2; fi
}

tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/repo with spaces"
stubbin="$tmp/bin"
log="$tmp/log"
stable="$tmp/game stable"
beta="$tmp/game beta"
mkdir -p "$fixture/scripts" "$stubbin" "$log" \
  "$stable/assemblies" "$stable/mods" "$beta/assemblies" "$beta/mods"
cp "$repo_root/scripts/build-local-mod.sh" "$repo_root/scripts/stamp-local-mod.sh" "$fixture/scripts/"
for helper in build-msdf-generator build-render-stream; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/scripts/$helper.sh"
  chmod +x "$fixture/scripts/$helper.sh"
done
printf '{"version":"v0.107.1"}\n' > "$stable/release_info.json"
printf '{"version":"v0.113.0"}\n' > "$beta/release_info.json"
printf 'game:\n  path: "%s"\n  assembliesDir: "%s/assemblies"\n' "$stable" "$stable" > "$fixture/sts2.local.yaml"

cat > "$stubbin/sts2" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BUILD_GUARD_LOG/resolve"
cat "$BUILD_GUARD_RESOLVE"
STUB
cat > "$stubbin/dotnet" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$BUILD_GUARD_LOG/$1"
if [[ "$1" == publish ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == -o ]]; then
      printf '{"version":"0.0.0"}\n' > "$2/couchcoop.json"
      break
    fi
    shift
  done
elif [[ "$1" == msbuild ]]; then
  printf '%s\n' "${STS2_ASSEMBLIES_DIR:-}" "${CouchCoopLocalConfigPath:-}" > "$BUILD_GUARD_LOG/probe-env"
fi
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$stubbin/npm"
chmod +x "$stubbin/sts2" "$stubbin/dotnet" "$stubbin/npm"

resolve_config() { # assemblies, config dir, game path
  jq -n --arg assemblies "$1" --arg config "$2" --arg game "$3" \
    '{assembliesDir:$assemblies, configDir:$config, gamePath:$game, modsDir:($game + "/mods")}' > "$tmp/resolve.json"
  rm -f "$log/"*
}
run() {
  env -u STS2_ASSEMBLIES_DIR -u CouchCoopLocalConfigPath -u SPIRECTL_CONFIG_DIR \
    -u SPIRECTL_DEPLOY_OUTPUT_DIR -u COUCHCOOP_LOCAL_MOD_DIR \
    PATH="$stubbin:$PATH" BUILD_GUARD_LOG="$log" BUILD_GUARD_RESOLVE="$tmp/resolve.json" \
    "$@" > "$tmp/stdout" 2> "$tmp/stderr"
}
build() { run bash "$fixture/scripts/build-local-mod.sh" "$@"; }
both_builds_use() {
  ok "publish receives $1" grep -qxF -- "$1" "$log/publish"
  ok "hot-reload receives $1" grep -qxF -- "$1" "$log/build"
}

echo '== mismatch refuses before publishing or cleaning the existing deploy =='
resolve_config "$stable/assemblies" "$fixture" "$beta"
output="$beta/mods/couchcoop"
mkdir -p "$output/lanes/old"
touch "$output/keep.dll" "$output/lanes/old/keep.dll"
build --output "$output"
eq 'mismatch exits 3' 3 "$?"
ok 'no publish was invoked' test ! -e "$log/publish"
ok 'no hot-reload build was invoked' test ! -e "$log/build"
ok 'top-level deploy files survive' test -f "$output/keep.dll"
ok 'release lanes survive' test -f "$output/lanes/old/keep.dll"
ok 'diagnostic names compiled version' grep -qF 'v0.107.1' "$tmp/stderr"
ok 'diagnostic names target version' grep -qF 'v0.113.0' "$tmp/stderr"
ok 'diagnostic names assemblies path' grep -qF "$stable/assemblies" "$tmp/stderr"
ok 'diagnostic names target path' grep -qF "$beta" "$tmp/stderr"
ok 'diagnostic suggests the wrapper' grep -qF 'scripts/with-game-branch.sh <branch> -- scripts/build-local-mod.sh' "$tmp/stderr"
ok 'diagnostic suggests listing branches' grep -qF 'scripts/with-game-branch.sh list' "$tmp/stderr"

echo '== missing jq refuses before publishing or cleaning the existing deploy =='
no_jq_bin="$tmp/no-jq-bin"
mkdir -p "$no_jq_bin"
for tool in bash dirname sed head find rm mkdir mv date cat; do
  ln -s "$(command -v "$tool")" "$no_jq_bin/$tool"
done
for tool in sts2 dotnet npm; do
  ln -s "$stubbin/$tool" "$no_jq_bin/$tool"
done
resolve_config "$stable/assemblies" "$fixture" "$beta"
run PATH="$no_jq_bin" bash "$fixture/scripts/build-local-mod.sh" --output "$output"
eq 'missing jq fails early' 1 "$?"
ok 'missing jq has a clear diagnostic' grep -qF 'jq is required' "$tmp/stderr"
ok 'missing jq never publishes' test ! -e "$log/publish"
ok 'missing jq never builds hot-reload' test ! -e "$log/build"
ok 'missing jq preserves top-level deploy files' test -f "$output/keep.dll"
ok 'missing jq preserves release lanes' test -f "$output/lanes/old/keep.dll"

echo '== matching resolved paths feed both builds, with exactly one resolve =='
resolve_config "$beta/assemblies" "$fixture" "$beta"
build --output "$output"
eq 'match succeeds' 0 "$?"
both_builds_use "-p:Sts2AssembliesDir=$beta/assemblies"
eq 'one resolve includes assembliesDir' '--json config resolve modsDir gamePath assembliesDir' "$(cat "$log/resolve")"
ok 'stale top-level assembly was removed' test ! -e "$output/keep.dll"
ok 'stale release lanes were removed' test ! -e "$output/lanes"
eq 'stamp probes the selected assemblies' "$beta/assemblies" "$(head -n 1 "$log/probe-env")"

echo '== default output uses the same cached resolve =='
resolve_config "$beta/assemblies" "$fixture" "$beta"
build
eq 'default output succeeds' 0 "$?"
eq 'default output resolves once' '--json config resolve modsDir gamePath assembliesDir' "$(cat "$log/resolve")"
eq 'default output follows CLI modsDir' "$output" "$(tail -n 1 "$tmp/stdout" | jq -r .outputDir)"

echo '== a different config directory follows the CLI into MSBuild =='
config_dir="$tmp/branch config"
mkdir -p "$config_dir"
cp "$fixture/sts2.local.yaml" "$config_dir/sts2.local.yaml"
resolve_config "$beta/assemblies" "$config_dir" "$beta"
run SPIRECTL_CONFIG_DIR="$config_dir" bash "$fixture/scripts/build-local-mod.sh" --output "$output"
eq 'external config succeeds' 0 "$?"
both_builds_use "-p:CouchCoopLocalConfigPath=$config_dir/sts2.local.yaml"
eq 'stamp probes the selected config' "$config_dir/sts2.local.yaml" "$(tail -n 1 "$log/probe-env")"
mv "$fixture/sts2.local.yaml" "$tmp/repo-config.yaml"
build --output "$output"
eq 'external config works without a repo-root local config' 0 "$?"
mv "$tmp/repo-config.yaml" "$fixture/sts2.local.yaml"

echo '== the wrapper assemblies environment override wins =='
resolve_config "$stable/assemblies" "$fixture" "$beta"
run STS2_ASSEMBLIES_DIR="$beta/assemblies" bash "$fixture/scripts/build-local-mod.sh" --output "$output"
eq 'matching env override succeeds' 0 "$?"
both_builds_use "-p:Sts2AssembliesDir=$beta/assemblies"
resolve_config "$beta/assemblies" "$fixture" "$beta"
run STS2_ASSEMBLIES_DIR="$stable/assemblies" bash "$fixture/scripts/build-local-mod.sh" --output "$output"
eq 'mismatching env override is checked' 3 "$?"
ok 'override mismatch never publishes' test ! -e "$log/publish"

echo '== explicit output and deploy environment identify their actual target =='
for output_env in SPIRECTL_DEPLOY_OUTPUT_DIR COUCHCOOP_LOCAL_MOD_DIR; do
  resolve_config "$stable/assemblies" "$fixture" "$stable"
  run "$output_env=$output" bash "$fixture/scripts/build-local-mod.sh"
  eq "$output_env target mismatch refuses" 3 "$?"
  ok "$output_env mismatch never publishes" test ! -e "$log/publish"
done
resolve_config "$stable/assemblies" "$fixture" "$stable"
build --output "$output"
eq '--output overrides the resolved game for the guard' 3 "$?"
ok 'explicit mismatch never publishes' test ! -e "$log/publish"

echo '== unknown versions continue with a skip reason =='
sdk="$tmp/reference-sdk"
mkdir -p "$sdk"
resolve_config "$sdk" "$fixture" "$beta"
build --output "$output"
eq 'reference SDK with no release info succeeds' 0 "$?"
ok 'unknown compiled version reports guard skipped' grep -qi 'guard skipped.*compiled.*release_info.json' "$tmp/stderr"
both_builds_use "-p:Sts2AssembliesDir=$sdk"
scratch="$tmp/scratch/mods/couchcoop"
resolve_config "$stable/assemblies" "$fixture" "$tmp/scratch"
build --output "$scratch"
eq 'unknown target version succeeds' 0 "$?"
ok 'unknown target reports guard skipped' grep -qi 'guard skipped.*target.*release_info.json' "$tmp/stderr"
printf '{broken json\n' > "$tmp/scratch/release_info.json"
build --output "$scratch"
eq 'malformed release info is unknown' 0 "$?"
ok 'malformed release info reports guard skipped' grep -qi 'guard skipped.*target' "$tmp/stderr"

echo '== no CLI: the local YAML still supplies assemblies =='
barebin="$tmp/no-cli-bin"
mkdir -p "$barebin"
for tool in bash dirname sed head find rm mkdir jq mv date cat; do
  ln -s "$(command -v "$tool")" "$barebin/$tool"
done
ln -s "$stubbin/dotnet" "$barebin/dotnet"
ln -s "$stubbin/npm" "$barebin/npm"
resolve_config "$beta/assemblies" "$fixture" "$beta"
run PATH="$barebin" bash "$fixture/scripts/build-local-mod.sh" --output "$stable/mods/couchcoop"
eq 'sed fallback succeeds without sts2' 0 "$?"
both_builds_use "-p:Sts2AssembliesDir=$stable/assemblies"
ok 'no CLI resolver ran' test ! -e "$log/resolve"
printf 'game:\n  path: "%s"\n' "$stable" > "$fixture/sts2.local.yaml"
resolve_config '' "$fixture" "$stable"
build --output "$stable/mods/couchcoop"
eq 'missing assembliesDir fails before compiling' 1 "$?"
ok 'missing assembliesDir has a setup error' grep -qF 'game.assembliesDir' "$tmp/stderr"
ok 'missing assembliesDir never publishes' test ! -e "$log/publish"

printf '\nbuild-local-mod-guard: %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
