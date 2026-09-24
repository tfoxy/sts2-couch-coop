#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
renderer="$repo_root/scripts/render-workshop-localizations.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-workshop-localization-tests.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() { echo "test-render-workshop-localizations: $*" >&2; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected '$1', got '$2'"; }
assert() { "$@" >/dev/null || fail "assertion failed: $*"; }

for command in jq cmp cp rm; do command -v "$command" >/dev/null || fail "missing test prerequisite: $command"; done

base="$test_root/workshop.json"
rendered="$test_root/rendered.json"
jq -n '{
  title: "stale title",
  description: "stale description",
  visibility: "public",
  changeNote: "keep me",
  tags: ["Utility"],
  dependencies: [],
  contentDescriptors: []
}' > "$base"

bash "$renderer" --base "$base" --output "$rendered"

expected_titles='{
  "english": "Couch Co-op",
  "french": "Couch Co-op (coop locale)",
  "italian": "Couch Co-op (co-op da divano)",
  "german": "Couch Co-op (Couch-Koop)",
  "spanish": "Couch Co-op (cooperativo local)",
  "japanese": "Couch Co-op（ローカル協力プレイ）",
  "koreana": "Couch Co-op (로컬 협동)",
  "polish": "Couch Co-op (kanapowy co-op)",
  "brazilian": "Couch Co-op (co-op de sofá)",
  "russian": "Couch Co-op (диванный кооп)",
  "schinese": "Couch Co-op（本地合作）",
  "latam": "Couch Co-op (cooperativo en el mismo sofá)",
  "thai": "Couch Co-op",
  "turkish": "Couch Co-op (Yerel Eşli Oyun)"
}'
languages=(english french italian german spanish japanese koreana polish brazilian russian schinese latam thai turkish)

assert_eq english "$(jq -r '.language' "$rendered")"
assert_eq 13 "$(jq '.localizations | length' "$rendered")"
assert_eq public "$(jq -r '.visibility' "$rendered")"
assert_eq 'keep me' "$(jq -r '.changeNote' "$rendered")"
assert jq -e --argjson expected "$expected_titles" --rawfile english "$repo_root/workshop/description.en.md" \
  '.title == $expected.english and .description == $english' "$rendered"

actual_languages="$(jq -c '[.language] + [.localizations[].language] | sort' "$rendered")"
expected_languages="$(printf '%s\n' "${languages[@]}" | jq -R . | jq -sc sort)"
assert_eq "$expected_languages" "$actual_languages"

for language in "${languages[@]:1}"; do
  description="$repo_root/workshop/localizations/$language.md"
  assert jq -e --arg language "$language" --argjson expected "$expected_titles" --rawfile description "$description" \
    '.localizations[] | select(.language == $language) | .title == $expected[$language] and .description == $description' \
    "$rendered"
done

# Source validation must make deletion and native-label drift loud before an uploader sees a config.
bad_source="$test_root/bad-source"
cp -a "$repo_root/workshop/." "$bad_source"
rm "$bad_source/localizations/french.md"
if bash "$renderer" --base "$base" --source "$bad_source" --output "$test_root/bad.json" >"$test_root/bad.out" 2>&1; then
  fail "renderer accepted a source bundle missing French"
fi
grep -qF 'must contain one description' "$test_root/bad.out" || fail "missing-source refusal was unclear"

cp "$repo_root/workshop/localizations/french.md" "$bad_source/localizations/french.md"
jq '.french = ""' "$repo_root/workshop/titles.json" > "$bad_source/titles.json"
if bash "$renderer" --base "$base" --source "$bad_source" --output "$test_root/bad.json" >"$test_root/blank.out" 2>&1; then
  fail "renderer accepted a blank title"
fi
grep -qF 'title for french is blank' "$test_root/blank.out" || fail "blank-title refusal was unclear"

# A mistyped post link would ship a dead link in one language's description; it must refuse instead.
cp "$repo_root/workshop/titles.json" "$bad_source/titles.json"
latam_link="/workshop/discussions/latam/phone-connection-troubleshooting.md]"
grep -qF -- "$latam_link" "$bad_source/localizations/latam.md" || fail "latam description no longer links its phone post"
latam_description="$(<"$bad_source/localizations/latam.md")"
printf '%s\n' "${latam_description//"$latam_link"/"/workshop/discussions/latam/phone.md]"}" > "$bad_source/localizations/latam.md"
if bash "$renderer" --base "$base" --source "$bad_source" --output "$test_root/bad.json" >"$test_root/link.out" 2>&1; then
  fail "renderer accepted a description with a broken post link"
fi
grep -qF 'latam description does not link its phone-connection-troubleshooting post' "$test_root/link.out" ||
  fail "broken-link refusal was unclear"

echo "test-render-workshop-localizations: ok"
