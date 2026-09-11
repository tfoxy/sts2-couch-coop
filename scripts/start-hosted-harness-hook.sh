#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="$repo_root/.sts2/artifacts/couchcoop-runtime-harness"
mkdir -p "$artifact_dir"
mode="${COUCHCOOP_HARNESS_MODE:-run}"
cache_root="$artifact_dir/resource-cache"
rm -rf "$cache_root"
mkdir -p "$cache_root"

COUCHCOOP_FRONTEND_OUT_DIR=dist npm --prefix "$repo_root/frontend" run build >/tmp/couchcoop-runtime-harness-npm.log 2>&1

log_path="$artifact_dir/server.log"
pid_path="$artifact_dir/server.pid"
base_url_path="$artifact_dir/base-url.json"

if [[ -f "$pid_path" ]]; then
  old_pid="$(cat "$pid_path")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    if ! kill "$old_pid" >/dev/null 2>&1; then
      :
    fi
    for _ in {1..20}; do
      if ! kill -0 "$old_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
  fi
fi

(
  cd "$repo_root"
  export DOTNET_ROLL_FORWARD=Major
  export COUCHCOOP_CACHE_ROOT="$cache_root"
  dotnet run --project tests/CouchCoop.HostedServerHarness/CouchCoop.HostedServerHarness.csproj -- \
    --static-root frontend/dist \
    --port 13337 \
    --mode "$mode"
) >"$log_path" 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" >"$pid_path"

base_url=""
for _ in {1..80}; do
if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    echo "hosted harness exited before reporting a URL" >&2
    if [[ -f "$log_path" ]]; then
      cat "$log_path" >&2
    fi
    exit 1
  fi

  if [[ -s "$log_path" ]]; then
    base_url="$(sed -n 's/.*"baseUrl":"\([^"]*\)".*/\1/p' "$log_path" | tail -1)"
    if [[ -n "$base_url" ]]; then
      break
    fi
  fi

  sleep 0.25
done

if [[ -z "$base_url" ]]; then
  echo "hosted harness did not report a URL" >&2
  if [[ -f "$log_path" ]]; then
    cat "$log_path" >&2
  fi
  exit 1
fi

printf '{"baseUrl":"%s","pid":%s,"mode":"%s"}\n' "$base_url" "$server_pid" "$mode" >"$base_url_path"
printf '{"output":{"baseUrl":"%s","pid":%s,"mode":"%s"},"artifacts":[{"path":"%s","kind":"json"},{"path":"%s","kind":"log"}]}\n' \
  "$base_url" \
  "$server_pid" \
  "$mode" \
  "$base_url_path" \
  "$log_path"
