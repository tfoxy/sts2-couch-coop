#!/usr/bin/env bash
set -euo pipefail

repo_root="${COUCHCOOP_VALIDATE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
workflow="${COUCHCOOP_WORKFLOW_PATH:-$repo_root/.github/workflows/macos-check.yml}"
failures=""

fail() {
  failures="${failures}${failures:+
}$1"
}

require_fixed() {
  pattern="$1"
  message="$2"
  grep -Fq -- "$pattern" "$workflow" || fail "$message"
}

reject_fixed() {
  pattern="$1"
  message="$2"
  if grep -Fq -- "$pattern" "$workflow"; then
    fail "$message"
  fi
}

require_count() {
  pattern="$1"
  expected="$2"
  message="$3"
  actual="$(grep -Fc -- "$pattern" "$workflow" || true)"
  if [ "$actual" -ne "$expected" ]; then
    fail "$message (expected $expected, found $actual)"
  fi
}

if [ ! -f "$workflow" ]; then
  echo "macOS/iPhone workflow is missing: $workflow" >&2
  exit 1
fi

require_fixed "workflow_dispatch:" "workflow_dispatch trigger is missing"
require_fixed "run_webkit:" "run_webkit dispatch input is missing"
require_fixed "run_arm:" "run_arm dispatch input is missing"
require_fixed "run_intel:" "run_intel dispatch input is missing"
require_fixed "default: true" "Apple Silicon must be the default dispatch architecture"
require_fixed "default: false" "Intel must remain opt-in"
require_fixed "- 'ci/macos'" "ci/macos branch trigger is missing"
require_fixed "contents: read" "workflow permissions must remain contents: read"

for job in policy macos-capture snapshot iphone_webkit macos_arm macos_intel; do
  require_fixed "  $job:" "required job is missing: $job"
done

require_count "needs: policy" 2 \
  "WebKit and the macOS capture must depend only on the policy gate"
reject_fixed "needs: [policy, iphone_webkit]" \
  "Mac jobs must not wait for the independent WebKit job"
require_fixed "inputs.run_webkit == true" \
  "the WebKit dispatch toggle must control the WebKit job"

# Scope package policy to each job so one correct Mac cannot mask a regression in the other.
job_source() {
  awk -v job="$1" '
    /^  [a-z0-9_-]+:$/ { selected = ($0 == "  " job ":") }
    selected { print }
  ' "$workflow"
}

snapshot_source="$(job_source snapshot)"
for required in \
  'needs: [policy, macos-capture]' \
  'runs-on: ubuntu-24.04' \
  "if: \${{ github.event_name == 'push' || inputs.run_arm == true || inputs.run_intel == true }}" \
  'rustup target add wasm32-unknown-unknown x86_64-pc-windows-gnullvm' \
  'cargo install wasm-bindgen-cli --version 0.2.129 --locked' \
  'run: scripts/package-release.sh --snapshot' \
  'name: couchcoop-snapshot-${{ github.run_id }}' \
  'path: sources/sts2-couch-coop/dist/couchcoop-snapshot-*.zip' \
  'if-no-files-found: error' \
  'retention-days: 1'; do
  if ! grep -Fq -- "$required" <<< "$snapshot_source"; then
    fail "Linux snapshot job must include: $required"
  fi
done
require_count 'run: scripts/package-release.sh --snapshot' 1 "only the Linux snapshot job may package a release"
for job in macos_arm macos_intel; do
  mac_source="$(job_source "$job")"
  if ! grep -Fq 'needs: [policy, snapshot]' <<< "$mac_source"; then
    fail "$job must depend on policy and snapshot"
  fi
  if grep -Fq 'package-release.sh' <<< "$mac_source"; then
    fail "$job must not run package-release.sh"
  fi
  for required in \
    'uses: actions/download-artifact@' \
    'name: couchcoop-snapshot-${{ github.run_id }}' \
    'path: sources/sts2-couch-coop/dist/'; do
    if ! grep -Fq -- "$required" <<< "$mac_source"; then
      fail "$job must download the Linux snapshot: $required"
    fi
  done
done

# Fixture artifacts are confined to this game-free producer's runner-temp directory. Each architecture must
# preserve its own stock/hardened evidence, including a comparison after stock failure.
for job in macos_arm macos_intel; do
  mac_source="$(job_source "$job")"
  fixture_step() {
    awk -v name="$1" '
      /^      - name:/ { selected = ($0 == "      - name: " name) }
      selected { print }
    ' <<< "$mac_source"
  }
  if [ "$job" = macos_arm ]; then
    runtime_arch=arm64
    runtime_sha=0deb23ac714dad69bf7d0c67e4253256d0845881b805cc8b9c6f2051283d5f9bbb000d363058523dce4c7361c2b460016a865b6d6baa5843c9263591d539eb20
  else
    runtime_arch=x64
    runtime_sha=70eb472ab24f38a6a6e930661e09ac6635dda0cf054899040c25cf3332f24f1cbb3eec19e1cfcf2214b466d000f6ddc7d49448a6c6106c3b70fd0bf7063f6e6d
  fi
  runtime_source="$(fixture_step "Install the game's .NET runtime privately")"
  for required in \
    "archive=\"\$RUNNER_TEMP/dotnet-runtime-9.0.7-osx-$runtime_arch.tar.gz\"" \
    'dotnet_root="$RUNNER_TEMP/couchcoop-dotnet-9.0.7"' \
    'curl --fail --location --retry 3 --retry-all-errors --retry-max-time 1200' \
    '--connect-timeout 15 --max-time 900 --output "$archive"' \
    "https://builds.dotnet.microsoft.com/dotnet/Runtime/9.0.7/dotnet-runtime-9.0.7-osx-$runtime_arch.tar.gz" \
    "expected_sha=$runtime_sha" \
    'test "$(shasum -a 512 "$archive" | awk '\''{print $1}'\'')" = "$expected_sha"' \
    'mkdir -p "$dotnet_root"' \
    'tar -xzf "$archive" -C "$dotnet_root"' \
    'set -- "$dotnet_root"/shared/Microsoft.NETCore.App/*' \
    'test "$#" -eq 1' \
    'test "$1" = "$dotnet_root/shared/Microsoft.NETCore.App/9.0.7"' \
    'test -d "$1"' \
    'set -- "$dotnet_root"/host/fxr/*/libhostfxr.dylib' \
    'test -f "$1"' \
    'echo "COUCHCOOP_GODOT_DOTNET_ROOT=$dotnet_root" >> "$GITHUB_ENV"'; do
    grep -Fq -- "$required" <<< "$runtime_source" \
      || fail "$job private runtime must include: $required"
  done
  previous_step="$(awk '
    /^      - name:/ {
      if ($0 == "      - name: Install the game\047s .NET runtime privately") print previous
      previous = $0
    }
  ' <<< "$mac_source")"
  [ "$previous_step" = '      - name: Download the pinned universal Godot .NET runtime' ] \
    || fail "$job private runtime install must follow the Godot download"
  build_source="$(fixture_step 'Build reference SDKs and public runtime fixtures')"
  grep -Fq 'id: build_fixtures' <<< "$build_source" \
    || fail "$job must expose the fixture build outcome"
  game_free_source="$(fixture_step 'Run game-free macOS and Harmony checks')"
  if grep -Fq -- '--godot-harmony-fixture' <<< "$game_free_source"; then
    fail "$job must run the stock Godot fixture in its own step"
  fi
  stock_source="$(fixture_step 'Run the stock Godot .NET Harmony fixture')"
  grep -Fq 'id: godot_fixture_stock' <<< "$stock_source" \
    || fail "$job must expose the stock fixture outcome"
  grep -Fq 'ls "$COUCHCOOP_GODOT_DOTNET_ROOT/shared/Microsoft.NETCore.App" >"$diagnostics/fixture-dotnet-runtimes.txt"' <<< "$stock_source" \
    || fail "$job stock fixture must record the private runtime versions"
  hardened_source="$(fixture_step 'Run the ad-hoc hardened Godot .NET fixture')"
  grep -Fq "if: \${{ !cancelled() && steps.build_fixtures.outcome == 'success' }}" <<< "$hardened_source" \
    || fail "$job hardened fixture must run after a stock failure when fixtures built"
  for variant in stock hardened; do
    if [ "$variant" = stock ]; then
      fixture_source="$stock_source"
      fixture_app='$COUCHCOOP_GODOT_APP'
    else
      fixture_source="$hardened_source"
      fixture_app='$signed_app'
    fi
    for required in \
      "diagnostics=\"\$RUNNER_TEMP/couchcoop-godot-harmony-fixture/$variant\"" \
      "--out \"\$RUNNER_TEMP/couchcoop-godot-harmony-fixture/$variant\"" \
      '--dotnet-root "$COUCHCOOP_GODOT_DOTNET_ROOT" --expect-framework '\''.NET 9.0.7'\''' \
      "codesign --display --verbose=4 \"$fixture_app\"" \
      'for arch in arm64 x86_64; do' \
      "codesign --display --entitlements :- --arch \"\$arch\" \"$fixture_app\"" \
      '>"$diagnostics/entitlements-$arch.plist" 2>"$diagnostics/entitlements-$arch.log" || true' \
      "lipo -archs \"$fixture_app/Contents/MacOS/Godot\"" \
      'dotnet --list-runtimes >"$diagnostics/dotnet-runtimes.txt"'; do
      grep -Fq -- "$required" <<< "$fixture_source" \
        || fail "$job $variant fixture must include: $required"
    done
  done
  upload_source="$(fixture_step 'Upload Godot Harmony fixture diagnostics')"
  if [ "$job" = macos_arm ]; then fixture_arch=arm64; else fixture_arch=x86_64; fi
  for required in \
    'if: always()' \
    'uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2' \
    "name: godot-harmony-fixture-$fixture_arch-\${{ github.run_id }}" \
    'path: ${{ runner.temp }}/couchcoop-godot-harmony-fixture' \
    'if-no-files-found: ignore' \
    'retention-days: 7'; do
    grep -Fq -- "$required" <<< "$upload_source" \
      || fail "$job fixture upload must include: $required"
  done
done
if grep -Eq '(^|[^[:alnum:]_])DOTNET_ROOT(_ARM64|_X64)?[[:space:]]*[:=]' "$workflow"; then
  fail "workflow must not set job-wide DOTNET_ROOT; only the Godot child may use the private runtime"
fi
require_count '--dotnet-root "$COUCHCOOP_GODOT_DOTNET_ROOT" --expect-framework '\''.NET 9.0.7'\''' 4 \
  "every Godot fixture invocation must pin its private runtime and expected framework"
require_count 'for key in allow-jit allow-unsigned-executable-memory allow-dyld-environment-variables disable-library-validation; do' 2 \
  "both Mac jobs must verify the game's four entitlement keys"
for key in allow-dyld-environment-variables allow-jit allow-unsigned-executable-memory disable-library-validation; do
  require_count "\"com.apple.security.cs.$key\"" 2 \
    "both Mac jobs must pin the exact entitlement JSON keys: $key"
done
reject_fixed 'disable-executable-page-protection' "Godot fixture must use only the game's four entitlements"

require_fixed "runs-on: ubuntu-24.04" "Ubuntu policy/WebKit runner is not pinned"
require_fixed "runs-on: macos-15" "Apple Silicon runner must be macos-15"
require_fixed "runs-on: macos-15-intel" "Intel runner must be macos-15-intel"
require_count "Godot_v4.5.1-stable_mono_macos.universal.zip" 4 \
  "both Mac jobs must use the pinned Godot .NET archive name and URL"
require_count "f00ee565e9d3682584117ef8865f5ff6d8f571fbf2733075ee06b9e0953261b8" 2 \
  "both Mac jobs must verify the pinned Godot .NET SHA-256"
require_count "--godot-harmony-fixture" 4 \
  "both Mac jobs must run stock and ad-hoc-hardened Godot Harmony fixtures"
require_count 'fixture_bin="$fixture_stage/.godot/mono/temp/bin/Debug"' 2 \
  "both Mac jobs must stage the Debug fixture expected by the Godot editor binary"
require_count 'CouchCoop.MacOs.GodotHarmonyFixture.runtimeconfig.json 0Harmony.dll GodotSharp.dll' 2 \
  "both Mac jobs must verify the staged Godot fixture runtime closure"
require_count "codesign --force --deep --sign - --options runtime" 2 \
  "both Mac jobs must create an ad-hoc hardened fixture copy"
require_count 'plutil -convert json -o - "$actual_entitlements"' 2 \
  "both Mac jobs must verify the exact hardened-runtime entitlement set"
require_count "-p:CouchCoopBetaTargetsMode=metadata" 6 \
  "both Mac jobs must restore and run the metadata-only target mode"
require_count '-p:CouchCoopLocalConfigPath="$RUNNER_TEMP/no-local-game-config.yaml"' 6 \
  "metadata-only target verification must not consult a developer game configuration"
require_count "-p:CouchCoopBetaTargetsMode=metadata -p:Sts2GameApi=v111" 2 \
  "public-beta metadata guards must use API v111 on both Mac jobs"
require_count "-p:CouchCoopBetaTargetsMode=metadata -p:Sts2GameApi=v113" 2 \
  "beta-v113 metadata guards must use API v113 on both Mac jobs"
require_count "--mode iphone-burst-self-test" 2 \
  "both Mac jobs must verify the frozen iPhone workload manifests and acknowledgement gates"
require_count "npm --prefix frontend run test:iphone-webkit" 1 \
  "Ubuntu must run the reviewed sequential WebKit profile wrapper exactly once"
webkit_runner="$repo_root/frontend/iphone-webkit/run.mjs"
if [ ! -f "$webkit_runner" ] \
  || ! grep -Fq 'for (const profile of ["baseline", "field-repro"])' "$webkit_runner"; then
  fail "the WebKit wrapper must run baseline then field-repro"
fi
require_fixed "beta-targets \"\$RUNNER_TEMP/couchcoop-reference-sdk/public-beta/sts2.dll\"" \
  "public-beta reference lane metadata guard is missing"
require_fixed "beta-targets \"\$RUNNER_TEMP/couchcoop-reference-sdk/beta-v113/sts2.dll\"" \
  "beta-v113 reference lane metadata guard is missing"
require_count "name: Run iPhone 13 Simulator Safari survival contract" 1 \
  "the exact iPhone Simulator contract must run only on Apple Silicon"
require_fixed "id: iphone_safari_contract" \
  "the ARM Simulator producer must expose an outcome for artifact validation"
require_fixed "steps.iphone_safari_contract.outcome != 'skipped'" \
  "ARM artifacts must not be validated when their producer was skipped"
require_fixed "-p:Sts2GameApi=v111 -p:CouchCoopBuildToLocalMods=false --" \
  "the ARM Simulator harness must preserve its verified public-beta API lane"
require_fixed "--iphone-profile field-repro" "ARM Simulator must run the field-reproduction profile"
require_fixed 'harness_err="$artifact_dir/iphone-safari-host.log"' \
  "ARM Simulator must stage the full synthetic host stderr log"
arm_cleanup="$(job_source macos_arm | sed -n '/^          cleanup_harness() {$/,/^          }$/p' \
  | sed -n '/wait "\$harness_pid"/,$p')"
for required in \
  "sed -E 's/visit=[0-9a-f]{32}/visit=<redacted>/g; s#https?://[^[:space:]\"<>]+#<redacted-url>#g' \"\$harness_err\" >\"\$harness_err.redacted\"" \
  'mv "$harness_err.redacted" "$harness_err"'; do
  if ! grep -Fq -- "$required" <<< "$arm_cleanup"; then
    fail "ARM Simulator must redact visit identifiers after stopping the host"
  fi
done
arm_upload="$(job_source macos_arm | sed -n '/name: Upload staged ARM Simulator diagnostics/,$p')"
if ! grep -Fq "if: \${{ always() && steps.validate_arm_artifacts.outcome == 'success' }}" <<< "$arm_upload"; then
  fail "ARM Simulator upload must run after a failed contract when artifact validation succeeds"
fi
reject_fixed "iphone-safari-intel" "Intel must not stage or upload iPhone Simulator artifacts"

# Every named step puts its timeout immediately after its name. Keeping this mechanically checkable prevents a
# newly added download or browser process from inheriting the much wider job timeout by accident.
missing_step_timeouts="$({
  awk '
    /^[[:space:]]+- name:/ {
      step = $0
      if ((getline next_line) <= 0 || next_line !~ /^[[:space:]]+timeout-minutes:/) print step
    }
  ' "$workflow"
} || true)"
if [ -n "$missing_step_timeouts" ]; then
  fail "named workflow steps without an immediate timeout-minutes line:$missing_step_timeouts"
fi

job_count="$(awk '
  /^jobs:$/ { in_jobs = 1; next }
  in_jobs && /^  [a-z0-9_-]+:$/ { count += 1 }
  END { print count + 0 }
' "$workflow")"
job_timeout_count="$(grep -Ec '^    timeout-minutes: [0-9]+$' "$workflow" || true)"
if [ "$job_count" -ne "$job_timeout_count" ]; then
  fail "every job must have exactly one explicit timeout ($job_count jobs, $job_timeout_count timeouts)"
fi

checkout_count="$(grep -Fc 'uses: actions/checkout@' "$workflow" || true)"
credential_count="$(grep -Fc 'persist-credentials: false' "$workflow" || true)"
if [ "$checkout_count" -eq 0 ] || [ "$checkout_count" -ne "$credential_count" ]; then
  fail "every checkout must set persist-credentials: false"
fi

real_url="COUCHCOOP_E2E_"'REAL_URL'
real_allow="COUCHCOOP_ALLOW_"'REAL_GAME'
reject_fixed "$real_url" "real-server URL must never enter Actions"
reject_fixed "$real_allow" "real-game opt-in must never enter Actions"
reject_fixed '${{ secrets.' "workflow must not read GitHub secrets"
reject_fixed '${{ vars.' "workflow must not read GitHub variables"
reject_fixed "self-hosted" "workflow must not select a self-hosted runner"
reject_fixed "steamcmd" "workflow must not install or invoke Steam tooling"

unpinned_actions="$(grep -E '^[[:space:]]+uses:' "$workflow" \
  | grep -Ev 'uses: [^[:space:]]+@[0-9a-f]{40}([[:space:]]+#.*)?$' || true)"
if [ -n "$unpinned_actions" ]; then
  fail "every workflow action must be pinned to a full commit SHA:$unpinned_actions"
fi

if grep -Eq '^    environment:|^      environment:' "$workflow"; then
  fail "workflow jobs and steps must not use GitHub environments"
fi

fixture_tag="STS2_MAC_"'FIXTURE_TAG'
fixture_name="macos-"'fixture'
real_job="macos-"'real-game'
private_fixture="private macOS "'fixture'
workshop_a="STS2_MAC_COUCHCOOP_"'WORKSHOP_ITEM_ID'
workshop_b="STS2_MAC_SPIRECTL_"'WORKSHOP_ITEM_ID'
for forbidden in "$fixture_tag" "$fixture_name" "$real_job" "$private_fixture" "$workshop_a" "$workshop_b"; do
  reject_fixed "$forbidden" "obsolete fixture/Steam identifier is forbidden: $forbidden"
done

upload_count="$(grep -Fc 'uses: actions/upload-artifact@' "$workflow" || true)"
if [ "$upload_count" -ne 6 ]; then
  fail "workflow must have exactly two synthetic uploads, two Godot fixture uploads, one macOS capture upload and one Linux snapshot upload"
fi
require_fixed "path: sources/sts2-couch-coop/.ci-artifacts/iphone-webkit" \
  "artifact upload path must be the reviewed repository-internal staging directory"
require_fixed "path: sources/sts2-couch-coop/.ci-artifacts/iphone-safari-arm" \
  "ARM Safari upload path must be the reviewed repository-internal staging directory"
require_fixed ".ci-artifacts/iphone-webkit/baseline" \
  "baseline WebKit profile validation is missing"
require_fixed ".ci-artifacts/iphone-webkit/field-repro" \
  "field-reproduction WebKit profile validation is missing"
require_fixed ".ci-artifacts/iphone-safari-arm/field-repro" \
  "ARM Safari field-reproduction validation is missing"
require_count "retention-days: 3" 2 "both synthetic artifact uploads must retain data for three days"
reject_fixed 'path: $RUNNER_TEMP' "upload-artifact must not read an external runner path"
reject_fixed "path: /" "upload-artifact paths must not be absolute"
reject_fixed "path: ../" "upload-artifact paths must not escape the checkout"

entitlements="$repo_root/tests/CouchCoop.MacOs.GodotHarmonyFixture/hardened-runtime.entitlements.plist"
if [ ! -f "$entitlements" ]; then
  fail "Godot hardened-runtime entitlements are missing"
else
  if ! python3 - "$entitlements" <<'PYPLIST'
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    actual = plistlib.load(source)
expected = {"com.apple.security.cs." + key: True for key in (
    "allow-dyld-environment-variables", "allow-jit",
    "allow-unsigned-executable-memory", "disable-library-validation",
)}
sys.exit(0 if actual == expected and all(value is True for value in actual.values()) else 1)
PYPLIST
  then
    fail "Godot hardened-runtime fixture must use exactly the game's four true entitlements"
  fi
fi

fixture_project="$repo_root/tests/CouchCoop.MacOs.GodotHarmonyFixture/project.godot"
if [ ! -f "$fixture_project" ] \
  || ! grep -Fq 'project/assembly_name="CouchCoop.MacOs.GodotHarmonyFixture"' "$fixture_project"; then
  fail "Godot fixture project must bind the generated assembly name explicitly"
fi

if [ -n "$failures" ]; then
  printf 'macOS/iPhone workflow policy failed:\n%s\n' "$failures" >&2
  exit 1
fi

echo "macOS/iPhone workflow policy: ok"
