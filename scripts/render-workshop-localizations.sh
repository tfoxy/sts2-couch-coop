#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/render-workshop-localizations.sh --base <workshop.json> [--source <directory>] [--output <file>]

Overlay the tracked public Workshop title and descriptions onto a workspace's operational
workshop.json fields. With no --output, writes the rendered JSON to stdout.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/workshop"
base=""
output=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 ;;
    --source) source_dir="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$base" && -f "$base" ]] || { echo "render-workshop-localizations: --base must name a file" >&2; exit 2; }
[[ -d "$source_dir" ]] || { echo "render-workshop-localizations: source directory does not exist: $source_dir" >&2; exit 1; }
command -v jq >/dev/null || { echo "render-workshop-localizations: jq is required" >&2; exit 1; }
jq -e 'type == "object"' "$base" >/dev/null || { echo "render-workshop-localizations: base must be a JSON object" >&2; exit 1; }

languages=(english french italian german spanish japanese koreana polish brazilian russian schinese latam thai turkish)
# Catalog filenames are not identical to runtime locale ids: English's runtime id is `eng`, while
# its embedded source file is `couchcoop.en.json`.
catalogs=(en fra ita deu esp jpn kor pol ptb rus zhs spa tha tur)
titles="$source_dir/titles.json"
english_description="$source_dir/description.en.md"

[[ -f "$titles" && -f "$english_description" ]] || {
  echo "render-workshop-localizations: titles.json and description.en.md are required" >&2
  exit 1
}

expected_languages="$(printf '%s\n' "${languages[@]}" | jq -R . | jq -sc 'sort')"
actual_languages="$(jq -c 'if type == "object" then keys | sort else error("titles must be an object") end' "$titles")" || {
  echo "render-workshop-localizations: titles.json must be an object" >&2
  exit 1
}
[[ "$actual_languages" == "$expected_languages" ]] || {
  echo "render-workshop-localizations: titles.json must contain exactly the supported Steam languages" >&2
  exit 1
}

expected_descriptions=()
for language in "${languages[@]:1}"; do expected_descriptions+=("$language.md"); done
actual_descriptions="$(find "$source_dir/localizations" -maxdepth 1 -type f -name '*.md' -printf '%f\n' 2>/dev/null | sort | jq -R . | jq -sc .)"
expected_description_json="$(printf '%s\n' "${expected_descriptions[@]}" | sort | jq -R . | jq -sc .)"
[[ "$actual_descriptions" == "$expected_description_json" ]] || {
  echo "render-workshop-localizations: localizations/ must contain one description for every non-English Steam language" >&2
  exit 1
}

for index in "${!languages[@]}"; do
  language="${languages[$index]}"
  catalog="${catalogs[$index]}"
  title="$(jq -er --arg language "$language" '.[$language] | strings | select(length > 0)' "$titles")" || {
    echo "render-workshop-localizations: title for $language is blank or missing" >&2
    exit 1
  }
  description="$english_description"
  [[ "$language" == english ]] || description="$source_dir/localizations/$language.md"
  [[ -s "$description" ]] || { echo "render-workshop-localizations: description for $language is blank" >&2; exit 1; }
  qr_label="$(jq -er '.couchcoop_qr_button | strings | select(length > 0)' \
    "$repo_root/src/CouchCoop.Mod/Localization/Catalogs/couchcoop.$catalog.json")" || {
    echo "render-workshop-localizations: native QR label is unavailable for $language" >&2
    exit 1
  }
  grep -Fq -- "$qr_label" "$description" || {
    echo "render-workshop-localizations: $language description does not name its current QR button: $qr_label" >&2
    exit 1
  }
done

localizations_tmp="$(mktemp "${TMPDIR:-/tmp}/couchcoop-workshop-localizations.XXXXXX")"
trap 'rm -f "$localizations_tmp"' EXIT
for language in "${languages[@]:1}"; do
  title="$(jq -er --arg language "$language" '.[$language]' "$titles")"
  jq -n --arg language "$language" --arg title "$title" \
    --rawfile description "$source_dir/localizations/$language.md" \
    '{language: $language, title: $title, description: $description}'
done | jq -s . > "$localizations_tmp"

english_title="$(jq -er '.english' "$titles")"
render() {
  jq --arg title "$english_title" --rawfile description "$english_description" \
    --slurpfile localizations "$localizations_tmp" \
    '.title = $title | .description = $description | .language = "english" | .localizations = $localizations[0]' \
    "$base"
}

if [[ -n "$output" ]]; then
  output_dir="$(dirname "$output")"
  [[ -d "$output_dir" ]] || { echo "render-workshop-localizations: output directory does not exist: $output_dir" >&2; exit 1; }
  output_tmp="$(mktemp "$output_dir/.workshop-localizations.XXXXXX")"
  render > "$output_tmp"
  mv "$output_tmp" "$output"
else
  render
fi
