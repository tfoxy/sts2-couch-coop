#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
fi

failures=()

check_file_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if ! grep -Fq "$pattern" "$file"; then
    failures+=("$label")
  fi
}

check_file_absent() {
  local pattern="$1"
  local label="$2"

  if grep -RInE "$pattern" frontend --exclude-dir=node_modules --exclude-dir=dist >/dev/null; then
    failures+=("$label")
  fi
}

check_file_contains frontend/package.json '"build"' "missing package build script"
check_file_contains frontend/package.json '"test"' "missing package test script"
check_file_contains frontend/package.json '"test:e2e"' "missing package test:e2e script"
check_file_absent 'Vue Router|vue-router' "vue-router must not be installed, imported, or referenced"

check_file_contains frontend/src/mirror/MirrorApp.vue 'data-testid="mirror-surface"' "missing mirror-surface test id"
check_file_contains frontend/src/styles.css 'html,' "missing html selector"
check_file_contains frontend/src/styles.css 'body,' "missing body selector"
check_file_contains frontend/src/styles.css '#app {' "missing #app selector"
check_file_contains frontend/src/styles.css '.game-surface {' "missing .game-surface selector"
check_file_contains frontend/src/styles.css 'background: #000' "missing black page background"
check_file_contains frontend/src/styles.css 'width: var(--zoom-stable-width, 100%)' "missing zoom-stable width policy"
check_file_contains frontend/src/styles.css 'height: var(--zoom-stable-height, 100%)' "missing zoom-stable height policy"
if grep -InE '100vw|100vh' frontend/src/styles.css >/dev/null; then
  failures+=("viewport units must not drive game surface sizing")
fi

if [[ ${#failures[@]} -gt 0 ]]; then
  if [[ "$json" == true ]]; then
    printf '{"ok":false,"failures":['
    for i in "${!failures[@]}"; do
      if [[ "$i" -gt 0 ]]; then
        printf ','
      fi
      printf '"%s"' "${failures[$i]}"
    done
    printf ']}\n'
  else
    printf 'frontend static validation failed:\n'
    printf ' - %s\n' "${failures[@]}"
  fi
  exit 1
fi

if [[ "$json" == true ]]; then
  printf '{"ok":true,"checks":["package-scripts","no-vue-router","mirror-surface","visual-policy-css"]}\n'
else
  printf 'frontend static validation passed\n'
fi
