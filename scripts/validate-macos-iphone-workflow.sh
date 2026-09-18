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

if [ ! -f "$workflow" ]; then
  echo "macOS/iPhone workflow is missing: $workflow" >&2
  exit 1
fi

require_fixed "workflow_dispatch:" "workflow_dispatch trigger is missing"
require_fixed "run_arm:" "run_arm dispatch input is missing"
require_fixed "run_intel:" "run_intel dispatch input is missing"
require_fixed "default: true" "Apple Silicon must be the default dispatch architecture"
require_fixed "default: false" "Intel must remain opt-in"
require_fixed "- 'ci/macos'" "ci/macos branch trigger is missing"
require_fixed "contents: read" "workflow permissions must remain contents: read"

for job in policy iphone_webkit macos_arm macos_intel; do
  require_fixed "  $job:" "required job is missing: $job"
done

require_fixed "runs-on: ubuntu-24.04" "Ubuntu policy/WebKit runner is not pinned"
require_fixed "runs-on: macos-15" "Apple Silicon runner must be macos-15"
require_fixed "runs-on: macos-15-intel" "Intel runner must be macos-15-intel"

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
  fail "workflow must have exactly three explicitly staged artifact uploads"
fi
require_fixed "path: sources/sts2-couch-coop/.ci-artifacts/iphone-webkit" \
  "artifact upload path must be the reviewed repository-internal staging directory"
require_fixed "path: sources/sts2-couch-coop/.ci-artifacts/iphone-safari-arm" \
  "ARM Safari upload path must be the reviewed repository-internal staging directory"
require_fixed "path: sources/sts2-couch-coop/.ci-artifacts/iphone-safari-intel" \
  "Intel Safari upload path must be the reviewed repository-internal staging directory"
require_fixed "retention-days: 3" "synthetic artifact retention must be three days"
reject_fixed 'path: $RUNNER_TEMP' "upload-artifact must not read an external runner path"
reject_fixed "path: /" "upload-artifact paths must not be absolute"
reject_fixed "path: ../" "upload-artifact paths must not escape the checkout"

if [ -n "$failures" ]; then
  printf 'macOS/iPhone workflow policy failed:\n%s\n' "$failures" >&2
  exit 1
fi

echo "macOS/iPhone workflow policy: ok"
