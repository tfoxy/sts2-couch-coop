#!/usr/bin/env bash
set -euo pipefail
: "${STREAMLINE_APC_IN:?Set the captured .apc input.}"
: "${STREAMLINE_TIMELINE_OUT:?Set the output CSV path.}"
: "${STREAMLINE_CLI:?Set the installed Streamline CLI executable.}"
[[ -s "$STREAMLINE_APC_IN" ]] || { echo 'APC archive is missing or empty' >&2; exit 2; }
[[ ! -e "$STREAMLINE_TIMELINE_OUT" ]] || { echo "Refusing to overwrite existing timeline: $STREAMLINE_TIMELINE_OUT" >&2; exit 2; }

output_dir="$(dirname "$STREAMLINE_TIMELINE_OUT")"
output_base="$(basename "$STREAMLINE_TIMELINE_OUT")"
mkdir -p "$output_dir"

validate_timeline() {
  node --input-type=module - "$1" <<'JS'
import { readFileSync } from 'node:fs';
const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split(/\r?\n/);
const headerIndex = lines.findIndex((line) => /^Index \(s\),/.test(line));
if (headerIndex < 0) throw Error('timeline CSV header Index(s) is missing');
const header = lines[headerIndex].split(',');
if (header.length < 2 || !header.some((name) => /mali|gpu/i.test(name))) throw Error('timeline header has no Mali/GPU columns');
const numeric = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const rows = [];
for (const [offset, raw] of lines.slice(headerIndex + 1).entries()) {
  if (!raw.trim()) continue;
  const row = raw.split(',');
  if (row.length !== header.length || row.some((cell) => !numeric.test(cell.trim()) || !Number.isFinite(Number(cell)) || Number(cell) < 0)) {
    throw Error(`invalid nonempty timeline row ${headerIndex + offset + 2}`);
  }
  rows.push(row.map(Number));
}
if (rows.length < 2) throw Error('timeline needs at least two numeric bins');
const bin = rows[1][0] - rows[0][0];
if (!(bin > 0)) throw Error('timeline bin index is not increasing');
for (let index = 2; index < rows.length; index++) {
  const delta = rows[index][0] - rows[index - 1][0];
  if (!(delta > 0) || Math.abs(delta - bin) > Math.max(1e-9, Math.abs(bin) * 1e-6)) {
    throw Error(`timeline bin index is irregular at row ${headerIndex + index + 2}`);
  }
}
JS
}

# Streamline can emit a Java crash footer after valid-looking CSV and still exit
# zero. Keep each immutable-APC attempt for diagnosis; only link a fully
# validated attempt to the requested output name.
for attempt in 1 2 3; do
  attempt_stdout="$(mktemp "$output_dir/.${output_base}.attempt-${attempt}.stdout.XXXXXX")"
  attempt_stderr="$(mktemp "$output_dir/.${output_base}.attempt-${attempt}.stderr.XXXXXX")"
  if "$STREAMLINE_CLI" -report "$STREAMLINE_APC_IN" -timeline -format csv >"$attempt_stdout" 2>"$attempt_stderr" \
    && validate_timeline "$attempt_stdout" 2>>"$attempt_stderr"; then
    # `ln` is no-clobber publication because the source and destination share
    # a directory/filesystem. The retained attempt stdout is the published CSV.
    if ln "$attempt_stdout" "$STREAMLINE_TIMELINE_OUT"; then
      printf '%s\n' "$STREAMLINE_TIMELINE_OUT"
      exit 0
    fi
    echo "Timeline output appeared while exporting; refusing to overwrite: $STREAMLINE_TIMELINE_OUT" >&2
    exit 2
  fi
  echo "Streamline timeline attempt $attempt failed validation; retained $attempt_stdout and $attempt_stderr" >&2
done
echo "Streamline timeline export failed validation after 3 immutable-APC attempts" >&2
exit 1
