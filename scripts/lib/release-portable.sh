# shellcheck shell=bash
# Small, deliberately boring portability layer for release scripts. These scripts are part of the
# release contract and run on stock macOS /bin/bash 3.2 and BSD userland as well as Linux CI.

release_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

release_file_size() {
  wc -c < "$1" | tr -d '[:space:]'
}

release_file_mode() {
  perl -e 'printf "%04o\n", (stat($ARGV[0]))[2] & 07777' "$1"
}

# Absolute paths of regular files directly beneath a directory. Globs, unlike GNU find depth
# predicates, work in both the stock macOS and Linux userlands. The dot globs intentionally omit .
# and .. while including ordinary hidden files.
release_list_immediate_files() {
  local root="$1" path
  for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [[ -f "$path" ]] || continue
    [[ "$(basename "$path")" != *$'\n'* ]] || { echo "release path contains a newline" >&2; return 1; }
    printf '%s\n' "$path"
  done
}

# Resolve a relative path only when every component has exactly the requested spelling. This matters
# on default APFS, where File.Exists and test -f accept a case-mismatched release_info.json.
release_exact_path() {
  local root="$1" relative="$2" current="$1" segment candidate found
  local segments=()
  IFS='/' read -r -a segments <<< "$relative"
  for segment in "${segments[@]}"; do
    found=""
    for candidate in "$current"/* "$current"/.[!.]* "$current"/..?*; do
      [[ -e "$candidate" || -L "$candidate" ]] || continue
      [[ "$(basename "$candidate")" == "$segment" ]] || continue
      found="$candidate"
      break
    done
    [[ -n "$found" ]] || return 1
    current="$found"
  done
  printf '%s\n' "$current"
}

# stdin: "<sha256><two spaces><relative file>". Verification is implemented here so the same
# manifest works without any platform-specific checksum command flags.
release_verify_checksums() {
  local manifest="$1" directory line expected name actual checked=0
  directory="$(cd "$(dirname "$manifest")" && pwd)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    expected="${line%%  *}"
    name="${line#*  }"
    [[ "$expected" =~ ^[0-9a-fA-F]{64}$ && "$name" != "$line" && -n "$name" ]] || {
      echo "invalid SHA256SUMS line: $line" >&2; return 1;
    }
    [[ -f "$directory/$name" ]] || { echo "checksum file names missing file: $name" >&2; return 1; }
    actual="$(release_sha256 "$directory/$name")" || return 1
    [[ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]] || {
      echo "checksum mismatch: $name" >&2; return 1;
    }
    checked=$((checked + 1))
  done < "$manifest"
  [[ "$checked" -gt 0 ]] || { echo "checksum file did not name an available file" >&2; return 1; }
}

# Versions are restricted to MAJOR.MINOR.PATCH by the lane table. Numeric key ordering is exactly
# the required semantic order for this restricted grammar on both BSD and GNU sort.
release_semver_sort() {
  sed 's/^v//' | LC_ALL=C sort -t . -k1,1n -k2,2n -k3,3n
}

release_semver_latest() {
  release_semver_sort | tail -n 1
}

# Like release_semver_latest, but keeps a leading v on git tags. Do not use the lane sorter here:
# stripping the prefix would make package-release reject an otherwise valid vMAJOR.MINOR.PATCH tag.
release_semver_tag_latest() {
  awk '
    {
      original = $0; version = $0; sub(/^v/, "", version)
      count = split(version, part, ".")
      if (count == 3 && part[1] ~ /^[0-9]+$/ && part[2] ~ /^[0-9]+$/ && part[3] ~ /^[0-9]+$/)
        printf "%012d.%012d.%012d\t%s\n", part[1], part[2], part[3], original
    }
  ' | LC_ALL=C sort | tail -n 1 | awk -F '\t' '{print $2}'
}

# Emits the exact relative paths below a root. Release payload names cannot contain newlines; fail
# rather than making a line-oriented release manifest ambiguous.
release_list_files() {
  local root="$1" path
  while IFS= read -r path; do
    [[ "$path" != *$'\n'* ]] || { echo "release path contains a newline" >&2; return 1; }
    printf '%s\n' "${path#./}"
  done < <(cd "$root" && find . -type f -print | LC_ALL=C sort)
}

release_list_directories() {
  local root="$1" path
  while IFS= read -r path; do
    [[ "$path" != *$'\n'* ]] || { echo "release path contains a newline" >&2; return 1; }
    printf '%s\n' "${path#./}"
  done < <(cd "$root" && find . -type d -print | sed '/^\.$/d' | LC_ALL=C sort)
}
