#!/usr/bin/env bash
set -euo pipefail

# Checks the Workshop discussion posts under workshop/discussions/: every Steam language has both posts,
# every link points where discussions.json says, and every translation still quotes its catalog's current
# on-screen labels. Read-only; docs/workshop/README.md explains the layout.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-workshop-discussion-tests.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() { echo "test-workshop-discussions: $*" >&2; exit 1; }

for command in jq grep find sort cp; do command -v "$command" >/dev/null || fail "missing test prerequisite: $command"; done

languages=(english french italian german spanish japanese koreana polish brazilian russian schinese latam thai turkish)
# Same pairing as scripts/render-workshop-localizations.sh: native catalog ids are not Steam language ids.
catalogs=(en fra ita deu esp jpn kor pol ptb rus zhs spa tha tur)
posts=(phone-connection-troubleshooting reporting-a-problem)
# The mod labels both posts name. A catalog change to any of them strands every translation that quotes it.
labels=(couchcoop_qr_button couchcoop_connection_title couchcoop_connection_copy_report)

# Prints the first problem in the <workshop> source tree and returns 1, or returns 0 when it is consistent.
check_tree() {
  local dir="$1/discussions"
  local index="$dir/discussions.json"
  jq -e --argjson posts "$(printf '%s\n' "${posts[@]}" | jq -R . | jq -sc sort)" '
    (.repository | type == "string" and startswith("https://github.com/"))
    and (.posts | type == "object" and (keys == $posts))
    and ([.posts[] | type == "string" and startswith("https://steamcommunity.com/")] | all)
  ' "$index" >/dev/null 2>&1 || {
    echo "discussions.json must name the GitHub repository and exactly one Steam URL per post"
    return 1
  }
  local repository expected actual
  repository="$(jq -r '.repository' "$index")"
  expected="$(printf '%s\n' discussions.json "${languages[@]}" | sort)"
  actual="$(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)"
  [[ "$actual" == "$expected" ]] || { echo "discussions/ must hold discussions.json and one folder per Steam language"; return 1; }

  local i language catalog extension post file other key label steam
  for i in "${!languages[@]}"; do
    language="${languages[$i]}"
    catalog="${catalogs[$i]}"
    extension=md
    [[ "$language" != english ]] || extension=bbcode
    expected="$(printf "%s.$extension\n" "${posts[@]}" | sort)"
    actual="$(find "$dir/$language" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)"
    [[ "$actual" == "$expected" ]] || { echo "$language/ must hold exactly the two posts as .$extension"; return 1; }

    for post in "${posts[@]}"; do
      file="$dir/$language/$post.$extension"
      [[ -s "$file" ]] || { echo "$language/$post.$extension is empty"; return 1; }
      for other in "${posts[@]}"; do
        [[ "$other" != "$post" ]] || continue
        if [[ "$language" == english ]]; then
          steam="$(jq -r --arg post "$other" '.posts[$post]' "$index")"
          grep -Fq -- "[url=$steam]" "$file" || { echo "english/$post.bbcode does not link the $other discussion"; return 1; }
        else
          grep -Fq -- "]($other.md)" "$file" || { echo "$language/$post.md does not link its sibling $other.md"; return 1; }
        fi
      done
      if [[ "$language" == english ]]; then
        for other in "${languages[@]:1}"; do
          grep -Fq -- "[url=$repository/workshop/discussions/$other/$post.md]" "$file" ||
            { echo "english/$post.bbcode does not link its $other translation"; return 1; }
        done
        continue
      fi
      steam="$(jq -r --arg post "$post" '.posts[$post]' "$index")"
      grep -Fq -- "]($steam)" "$file" || { echo "$language/$post.md does not link its Steam discussion"; return 1; }
      for key in "${labels[@]}"; do
        label="$(jq -er --arg key "$key" '.[$key] | strings | select(length > 0)' \
          "$repo_root/src/CouchCoop.Mod/Localization/Catalogs/couchcoop.$catalog.json")" ||
          { echo "catalog couchcoop.$catalog.json has no $key"; return 1; }
        grep -Fq -- "$label" "$file" || { echo "$language/$post.md does not quote its current $key: $label"; return 1; }
      done
    done
  done
}

if ! problem="$(check_tree "$repo_root/workshop")"; then
  fail "$problem"
fi

# Each check must bite: break one thing per copy and require the matching refusal.
expect_refusal() {
  local name="$1" expected="$2" problem
  if problem="$(check_tree "$test_root/$name")"; then
    fail "a tree with $name passed"
  fi
  [[ "$problem" == *"$expected"* ]] || fail "a tree with $name was refused for the wrong reason: $problem"
}
break_copy() {
  local name="$1" file="$2" needle="$3" content
  cp -a "$repo_root/workshop/." "$test_root/$name"
  content="$(<"$test_root/$name/discussions/$file")"
  [[ "$content" == *"$needle"* ]] || fail "fixture $name: $file does not contain '$needle'"
  printf '%s\n' "${content//"$needle"/BROKEN}" > "$test_root/$name/discussions/$file"
}

steam_report="$(jq -r '.posts["reporting-a-problem"]' "$repo_root/workshop/discussions/discussions.json")"
break_copy missing-steam-link french/reporting-a-problem.md "]($steam_report)"
expect_refusal missing-steam-link 'french/reporting-a-problem.md does not link its Steam discussion'

qr_label="$(jq -r '.couchcoop_qr_button' "$repo_root/src/CouchCoop.Mod/Localization/Catalogs/couchcoop.deu.json")"
break_copy stale-label german/phone-connection-troubleshooting.md "$qr_label"
expect_refusal stale-label 'german/phone-connection-troubleshooting.md does not quote its current couchcoop_qr_button'

break_copy missing-translation-link english/reporting-a-problem.bbcode "/thai/reporting-a-problem.md]"
expect_refusal missing-translation-link 'english/reporting-a-problem.bbcode does not link its thai translation'

echo "test-workshop-discussions: ok"
