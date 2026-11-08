#!/usr/bin/env bash
# Scoped worker checks. C# suites are executable runners; no frontend build or deployment.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

stage="frontend typecheck"
trap 'result=$?; echo "codex-check: $stage failed (exit $result)" >&2; exit "$result"' ERR

# The loader otherwise defaults to writing build output into the installed mod directory.
export CouchCoopBuildToLocalMods=false

cd frontend
npx vue-tsc --noEmit
cd ..

stage="related frontend tests"
base="${CODEX_CHECK_BASE:-main}"
merge_base="$(git merge-base HEAD "$base")"
changed_paths="$(mktemp)"
trap 'rm -f "$changed_paths"' EXIT
git diff --name-only --diff-filter=d -z "$merge_base" -- frontend/ > "$changed_paths"
git ls-files --others --exclude-standard -z -- frontend/ >> "$changed_paths"
frontend_files=()
while IFS= read -r -d '' path; do
  [ -f "$path" ] || continue
  frontend_files+=("${path#frontend/}")
done < "$changed_paths"

if [ "${#frontend_files[@]}" -eq 0 ]; then
  echo "codex-check: no changed frontend files; skipping related tests"
else
  cd frontend
  npx vitest related --run --maxWorkers=2 "${frontend_files[@]}"
  cd ..
fi

stage="MirrorProtocol tests"
dotnet run --project tests/CouchCoop.MirrorProtocol.Tests
stage="Mod tests"
dotnet run --project tests/CouchCoop.Mod.Tests
echo "codex-check: all stages passed"
