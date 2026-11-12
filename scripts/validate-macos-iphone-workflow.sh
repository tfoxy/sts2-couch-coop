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

for job in policy snapshot iphone_webkit macos_arm macos_intel; do
  require_fixed "  $job:" "required job is missing: $job"
done

require_count "needs: policy" 2 \
  "WebKit and the Linux snapshot must depend only on the policy gate"
reject_fixed "needs: [policy, iphone_webkit]" \
  "Mac jobs must not wait for the independent WebKit job"
require_fixed "inputs.run_webkit == true" \
  "the WebKit dispatch toggle must control the WebKit job"

# Scope package policy to each job so one correct Mac cannot mask a regression in the other.
job_source() {
  awk -v job="$1" '
    /^  [a-z0-9_]+:$/ { selected = ($0 == "  " job ":") }
    selected { print }
  ' "$workflow"
}

snapshot_source="$(job_source snapshot)"
for required in \
  'needs: policy' \
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
require_count "-p:CouchCoopBetaTargetsMode=metadata -p:Sts2GameApi=v107" 2 \
  "stable metadata guards must use API v107 on both Mac jobs"
require_count "-p:CouchCoopBetaTargetsMode=metadata -p:Sts2GameApi=v111" 2 \
  "public-beta metadata guards must use API v111 on both Mac jobs"
require_count "--mode iphone-burst-self-test" 2 \
  "both Mac jobs must verify the frozen iPhone workload manifests and acknowledgement gates"
require_count "npm --prefix frontend run test:iphone-webkit" 1 \
  "Ubuntu must run the reviewed sequential WebKit profile wrapper exactly once"
webkit_runner="$repo_root/frontend/iphone-webkit/run.mjs"
if [ ! -f "$webkit_runner" ] \
  || ! grep -Fq 'for (const profile of ["baseline", "field-repro"])' "$webkit_runner"; then
  fail "the WebKit wrapper must run baseline then field-repro"
fi
require_fixed "beta-targets \"\$RUNNER_TEMP/couchcoop-reference-sdk/stable/sts2.dll\"" \
  "stable reference lane metadata guard is missing"
require_fixed "beta-targets \"\$RUNNER_TEMP/couchcoop-reference-sdk/public-beta/sts2.dll\"" \
  "public-beta reference lane metadata guard is missing"
require_count "name: Run iPhone 13 Simulator Safari survival contract" 1 \
  "the exact iPhone Simulator contract must run only on Apple Silicon"
require_fixed "id: iphone_safari_contract" \
  "the ARM Simulator producer must expose an outcome for artifact validation"
require_fixed "steps.iphone_safari_contract.outcome != 'skipped'" \
  "ARM artifacts must not be validated when their producer was skipped"
require_fixed "-p:Sts2GameApi=v107 -p:CouchCoopBuildToLocalMods=false --" \
  "the ARM Simulator harness must preserve its verified stable API lane"
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
  in_jobs && /^  [a-z0-9_]+:$/ { count += 1 }
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
if [ "$upload_count" -ne 3 ]; then
  fail "workflow must have exactly two synthetic uploads and one Linux snapshot upload"
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
  for entitlement in allow-jit allow-unsigned-executable-memory allow-dyld-environment-variables disable-executable-page-protection disable-library-validation; do
    grep -Fq "com.apple.security.cs.$entitlement" "$entitlements" \
      || fail "Godot hardened-runtime entitlement is missing: $entitlement"
  done
  if grep -Fq "get-task-allow" "$entitlements"; then
    fail "Godot hardened-runtime fixture must not request get-task-allow"
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
