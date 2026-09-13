# Shared release-lane vocabulary. Sourced by scripts/package-release.sh,
# scripts/verify-release-archive.sh and scripts/upload-workshop-release.sh — never executed.
#
# A lane is named after a GAME STEAM BRANCH (`stable`, `public-beta`) and selects which pinned STS2
# reference package a release build compiles against (eng/Sts2.ReferenceSdk/<lane>/). The `-beta`
# suffix on a NuGet package version is PRERELEASE and says nothing about the branch: `0.107.0-beta`
# is the STABLE lane's pin. Never read a lane off a package version suffix.

# The lane whose archive keeps the unsuffixed, user-facing name. README's `gh attestation verify
# <zip>` block and every existing download link name couchcoop-<tag>.zip, so that filename is a
# published contract: only the other lanes get a suffix.
RELEASE_LANE_DEFAULT="stable"

# Lane names appear inside anchored regexes and filenames, so keep them boring.
release_lane_is_valid_name() {
  [[ "$1" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
}

# The minimum game version a lane's payload manifest declares, or empty for none.
#
# `min_game_version` is an STS2 manifest field that is already present and enforced in stable, and is
# compared as a SemanticVersion rather than a string (a leading `v` is accepted and is the game's own
# rendering in release_info.json). The failure to avoid is MOD_ERROR.GAME_VERSION_INVALID: a value
# that does not parse makes the mod fail to load on EVERY build including the right one, which is
# strictly worse than declaring no floor at all. Hence one reviewed literal per lane, and a format
# gate on the way out — a caller can never receive a malformed value from here.
#
# The asymmetry, which is not fixable here: being a minimum, this makes the beta payload refuse an
# older game loudly, but nothing stops the stable payload loading on a newer game. There is no
# `max_game_version`; only the Workshop's `maxBranch` scopes downward.
# The spirectl bridge API lane a release lane compiles against.
#
# A release build compiles against the pinned reference SDK, which is a bare assemblies directory
# with no release_info.json — so the bridge's own lane detection cannot fire and MUST be told. It
# also cannot be derived: the reference sts2.dll carries no game-version string, and the package
# version does not track the game's (`0.107.0-beta` pairs with game v0.107.1). Hence one reviewed
# row here. The authoritative version-to-lane table stays in ../spirectl/bridge-mod/Sts2GameApi.props
# and rejects an unknown lane, so a wrong value fails the build loudly rather than mis-compiling.
release_lane_game_api() {
  local lane="$1" value
  case "$lane" in
    stable) value="v107" ;;
    public-beta) value="v111" ;;
    *)
      echo "release-lanes: lane '$lane' has no reviewed bridge API lane; add one to scripts/lib/release-lanes.sh" >&2
      return 1
      ;;
  esac
  # Same contract as the manifest floor below: a caller can never receive a malformed value.
  if [[ ! "$value" =~ ^v[0-9]+$ ]]; then
    echo "release-lanes: bridge API lane for '$lane' is not v<digits>: $value" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

release_lane_min_game_version() {
  local lane="$1" value
  case "$lane" in
    # No floor: the stable payload must keep loading on every supported public build.
    stable) value="" ;;
    # Game v0.111.0 — the build eng/Sts2.ReferenceSdk/public-beta pins its references from.
    public-beta) value="v0.111.0" ;;
    *)
      echo "release-lanes: lane '$lane' has no reviewed min_game_version; add one to scripts/lib/release-lanes.sh" >&2
      return 1
      ;;
  esac
  if [[ -n "$value" && ! "$value" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "release-lanes: min_game_version for lane '$lane' is not vMAJOR.MINOR.PATCH: $value" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# A lane this repo has reviewed a manifest floor for. Packaging additionally requires the lane to
# exist on disk under eng/Sts2.ReferenceSdk/, so adding a lane has to touch both places.
release_lane_is_known() {
  release_lane_min_game_version "$1" >/dev/null 2>&1
}

# Lane directories on disk, the default lane first so a two-lane release builds the user-facing
# archive before the suffixed one. Deliberately read from disk instead of copying the reviewed list
# out of scripts/verify-sts2-reference-sdk.sh: an unreviewed lane then fails packaging loudly
# (that script rejects an unknown lane, and release_lane_min_game_version rejects an unmapped one)
# rather than being silently left out of the release.
release_lane_discover() {
  local sdk_root="$1" dir lane others=()
  [[ -d "$sdk_root" ]] || { echo "release-lanes: no reference SDK root: $sdk_root" >&2; return 1; }
  for dir in "$sdk_root"/*/; do
    lane="$(basename "$dir")"
    # Build output is unambiguously not a lane. Everything else still fails loudly below: an
    # unreviewed lane must not be silently dropped from a release, but a stray obj/ from someone's
    # local build must not be able to stop one either.
    case "$lane" in
      obj|bin) continue ;;
    esac
    release_lane_is_valid_name "$lane" || {
      echo "release-lanes: reference lane directory is not a usable lane name: $lane" >&2
      return 1
    }
    [[ -f "$dir/Sts2.ReferenceSdk.$lane.csproj" ]] || {
      echo "release-lanes: $dir holds no Sts2.ReferenceSdk.$lane.csproj" >&2
      return 1
    }
    if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then continue; fi
    others+=("$lane")
  done
  [[ -d "$sdk_root/$RELEASE_LANE_DEFAULT" ]] || {
    echo "release-lanes: the default lane '$RELEASE_LANE_DEFAULT' is missing from $sdk_root" >&2
    return 1
  }
  printf '%s\n' "$RELEASE_LANE_DEFAULT" ${others[@]+"${others[@]}"}
}

# <archive base> <lane> -> archive filename. The base is `couchcoop-vMAJOR.MINOR.PATCH` for a tagged
# release and `couchcoop-snapshot-<short sha>` for a --snapshot build.
release_lane_archive_name() {
  local base="$1" lane="$2"
  if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
    printf '%s.zip\n' "$base"
  else
    printf '%s-%s.zip\n' "$base" "$lane"
  fi
}

# The Steam game branch a lane's payload is built for. This is what links a Workshop revision to the
# game version that should receive it: Steam gives a subscriber the revision whose linked range covers
# the game version they are running, so one item serves both branches through one revision each.
#
# The names are Steam's, not ours -- the web UI's version picker shows the default branch as "Latest
# Version" and names every other branch directly, and `public` is what the API calls the default one.
release_lane_steam_branch() {
  local lane="$1" value
  case "$lane" in
    stable) value="public" ;;
    public-beta) value="public-beta" ;;
    *)
      echo "release-lanes: lane '$lane' has no reviewed Steam branch; add one to scripts/lib/release-lanes.sh" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$value"
}

# <archive filename> <lane> -> the release-wide base name, i.e. the archive name with its .zip and
# any lane suffix removed. One release publishes one SHA256SUMS covering every lane's archive, so
# every lane has to arrive at the same name for it.
release_checksums_name() {
  local archive="$1" lane="$2" base="${1%.zip}"
  if [[ "$lane" != "$RELEASE_LANE_DEFAULT" ]]; then
    base="${base%-$lane}"
  fi
  printf '%s\n' "$base"
}

# Anchored ERE matching one lane's RELEASED archive name, so a directory holding both lanes cannot
# hand the wrong payload to a lane-specific consumer.
release_lane_release_archive_regex() {
  local lane="$1"
  if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
    printf '^couchcoop-v[0-9]+\\.[0-9]+\\.[0-9]+\\.zip$\n'
  else
    printf '^couchcoop-v[0-9]+\\.[0-9]+\\.[0-9]+-%s\\.zip$\n' "$lane"
  fi
}

# The same, for a --snapshot build. Consumers that publish only released tags use this to say so
# precisely instead of reporting "no archive found".
release_lane_snapshot_archive_regex() {
  local lane="$1"
  if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
    printf '^couchcoop-snapshot-[0-9a-f]+\\.zip$\n'
  else
    printf '^couchcoop-snapshot-[0-9a-f]+-%s\\.zip$\n' "$lane"
  fi
}
