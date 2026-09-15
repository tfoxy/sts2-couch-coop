# Shared release-lane vocabulary. Sourced by scripts/package-release.sh,
# scripts/verify-release-archive.sh and scripts/upload-workshop-release.sh — never executed.
#
# A lane is named after a GAME STEAM BRANCH (`stable`, `public-beta`) and selects which pinned STS2
# reference package a release build compiles against (eng/Sts2.ReferenceSdk/<lane>/). The `-beta`
# suffix on a NuGet package version is PRERELEASE and says nothing about the branch: `0.107.0-beta`
# is the STABLE lane's pin. Never read a lane off a package version suffix.
#
# ONE RELEASE IS ONE ARCHIVE, carrying every lane. It used to be one archive per lane published as
# one branch-linked Workshop revision each, and the Steam client defeats that: branch-linked
# resolution runs only on the subscribe/first-acquire path, and every later periodic refresh takes
# the item's NEWEST revision branch-blind. Every stable subscriber therefore drifted onto the
# public-beta revision and the game refused it (`declares min game version v0.111.0 higher than
# current game version v0.107.1`). No minBranch/maxBranch fixes it — the clobbering path reads no
# range at all. So the payload carries `lanes/<floor>/` for every lane and picks one at runtime, and
# the per-lane archive name is gone.

# The lane listed first by release_lane_discover, and the one a consumer means by "the normal
# download". It no longer selects an archive name — there is only one archive — but it still orders
# the lane list and names the Steam branch a reader should assume.
RELEASE_LANE_DEFAULT="stable"

# Lane names appear inside anchored regexes and filenames, so keep them boring.
release_lane_is_valid_name() {
  [[ "$1" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
}

# Every lane this file reviews, in review order. Kept as a list, not derived from disk, because the
# payload gate must be able to say "this archive is missing a lane" from the archive alone. Adding a
# lane means adding it here AND to every reviewed table below AND to eng/Sts2.ReferenceSdk/ — which
# scripts/test-verify-release-archive.sh asserts, so a half-added lane fails loudly.
release_lane_known_names() {
  printf '%s\n' stable public-beta
}

# The assemblies that differ between lanes, and so ship once per lane under `lanes/<floor>/` instead
# of in the shared tree. Measured, not assumed: the two v0.2.1 archives differed in exactly these
# two files plus couchcoop.json and build-info.txt, and scripts/package-release.sh re-proves it on
# every build by holding every other published file byte-identical across lanes -- so a third file
# that starts varying fails the build instead of silently shipping one lane's copy to everyone.
release_lane_assembly_names() {
  printf '%s\n' CouchCoop.Mod.dll CouchCoop.Spirectl.dll
}

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

# The game build a lane's pinned reference package was taken from -- provenance, what a release can
# honestly say a lane was built FOR. Kept separate from the floor below even though the two literals
# are equal for every lane today: this one is a fact about the reference package, while the floor is
# the key the runtime selector compares a running game against. They would part company the moment a
# lane's references were re-pinned to a newer build it is still meant to load below.
release_lane_game_build() {
  local lane="$1" value
  case "$lane" in
    stable) value="v0.107.1" ;;
    public-beta) value="v0.111.0" ;;
    *)
      echo "release-lanes: lane '$lane' has no reviewed game build; add one to scripts/lib/release-lanes.sh" >&2
      return 1
      ;;
  esac
  if [[ ! "$value" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "release-lanes: game build for lane '$lane' is not vMAJOR.MINOR.PATCH: $value" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# The lowest game version a lane's assemblies are good for — its FLOOR. Every lane has one now,
# because the floor is what the runtime selector compares the running game against to choose a
# `lanes/<floor>/` directory, and it is what names that directory. A lane with no floor could not be
# ordered against the others and so could not be selected.
#
# `min_game_version` is an STS2 manifest field that is already present and enforced in stable, and is
# compared as a SemanticVersion rather than a string (a leading `v` is accepted and is the game's own
# rendering in release_info.json). The failure to avoid is MOD_ERROR.GAME_VERSION_INVALID: a value
# that does not parse makes the mod fail to load on EVERY build including the right one, which is
# strictly worse than declaring no floor at all. Hence one reviewed literal per lane, and a format
# gate on the way out — a caller can never receive a malformed value from here.
#
# The MERGED payload declares the LOWEST of these floors (release_payload_min_game_version), because
# the manifest gate runs before any lane is chosen: a manifest floor of v0.111.0 would make the one
# payload refuse to load on the stable branch it also carries.
#
# The asymmetry, which is not fixable here: being a minimum, the manifest floor makes the payload
# refuse an older game loudly, but nothing stops it loading on a newer one. There is no
# `max_game_version`; the lane SELECTOR, not the manifest, is what keeps a newer game off the older
# lane's assemblies.
release_lane_game_floor() {
  local lane="$1" value
  case "$lane" in
    # Game v0.107.1 — the build eng/Sts2.ReferenceSdk/stable pins its references from. This used to
    # be empty ("the stable payload must load on every supported public build"), which a merged
    # payload cannot express: an unordered lane cannot be picked. v0.107.1 is the oldest build this
    # repo has ever built references for, so nothing that used to load loses the mod here.
    stable) value="v0.107.1" ;;
    # Game v0.111.0 — the build eng/Sts2.ReferenceSdk/public-beta pins its references from.
    public-beta) value="v0.111.0" ;;
    *)
      echo "release-lanes: lane '$lane' has no reviewed game floor; add one to scripts/lib/release-lanes.sh" >&2
      return 1
      ;;
  esac
  if [[ ! "$value" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "release-lanes: game floor for lane '$lane' is not vMAJOR.MINOR.PATCH: $value" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# The payload directory a lane's assemblies ship in: its floor, bare, without the `v`.
#
# The directory names ARE the lane table. There is deliberately no manifest file inside the payload
# listing them, because STS2 reads EVERY `*.json` under a mod directory, recursively, as a mod
# manifest — a second one registers a phantom mod. scripts/verify-release-archive.sh allows exactly
# two assemblies under each lane directory for the same reason.
release_lane_dir_name() {
  local floor
  floor="$(release_lane_game_floor "$1")" || return 1
  printf '%s\n' "${floor#v}"
}

# <lane directory name> -> the lane that owns it, or a failure. This is how the payload gate reads
# the lane table back out of an archive without trusting anything inside it.
release_lane_from_dir_name() {
  local wanted="$1" lane
  [[ "$wanted" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  while IFS= read -r lane; do
    [[ "$(release_lane_dir_name "$lane")" == "$wanted" ]] || continue
    printf '%s\n' "$lane"
    return 0
  done < <(release_lane_known_names)
  return 1
}

# <lane>... -> the `min_game_version` the merged manifest declares: the LOWEST floor among the lanes
# the payload actually carries. Sorted with sort -V over the numeric part, so 0.9.0 < 0.11.0 the way
# a version sorts and not the way a string does.
release_payload_min_game_version() {
  local lane floor floors=() lowest
  [[ $# -gt 0 ]] || { echo "release-lanes: release_payload_min_game_version needs at least one lane" >&2; return 1; }
  for lane in "$@"; do
    floor="$(release_lane_game_floor "$lane")" || return 1
    floors+=("$floor")
  done
  lowest="$(printf '%s\n' "${floors[@]#v}" | sort -V | head -n 1)"
  [[ "$lowest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "release-lanes: merged floor did not resolve to MAJOR.MINOR.PATCH: $lowest" >&2
    return 1
  }
  printf 'v%s\n' "$lowest"
}

# A lane this repo has reviewed a floor for. Packaging additionally requires the lane to exist on
# disk under eng/Sts2.ReferenceSdk/, so adding a lane has to touch both places.
release_lane_is_known() {
  release_lane_game_floor "$1" >/dev/null 2>&1
}

# Lane directories on disk, the default lane first: packaging seeds the merged payload's SHARED tree
# from the first lane it builds and then holds every later lane byte-identical to it, so the shared
# files a player gets are the default lane's. Deliberately read from disk instead of copying the
# reviewed list out of scripts/verify-sts2-reference-sdk.sh: an unreviewed lane then fails packaging
# loudly (that script rejects an unknown lane, and release_lane_game_floor rejects an unmapped one)
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

# <archive base> -> the archive filename. The base is `couchcoop-vMAJOR.MINOR.PATCH` for a tagged
# release and `couchcoop-snapshot-<short sha>` for a --snapshot build.
#
# One release, one archive, no lane in the name. `couchcoop-<tag>.zip` is a published contract —
# README's `gh attestation verify <zip>` block and every existing download link name it — so the
# merged archive keeps exactly the name the stable archive already had, and `-public-beta.zip`
# simply stops existing.
release_archive_name() {
  printf '%s.zip\n' "$1"
}

# The Steam game branch a lane is built for. This USED to link a Workshop revision to the game
# version that should receive it; it no longer decides anything about publishing, because one
# revision now serves every branch and the payload picks its lane at runtime. It stays as the name a
# reader knows the branch by -- the one a download table or a log line says out loud.
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

# <archive filename> -> the release-wide base name, i.e. the archive name without its `.zip`. One
# release publishes one archive and one SHA256SUMS beside it, so this no longer takes a lane.
release_checksums_name() {
  printf '%s\n' "${1%.zip}"
}

# Anchored ERE matching the RELEASED archive name. It used to take a lane and match that lane's
# suffixed filename; a merged release has one archive, so the lane suffix is gone from the pattern
# too — and a leftover `couchcoop-v1.2.3-public-beta.zip` from an older release no longer matches,
# which is the point.
release_release_archive_regex() {
  printf '^couchcoop-v[0-9]+\\.[0-9]+\\.[0-9]+\\.zip$\n'
}

# The same, for a --snapshot build. Consumers that publish only released tags use this to say so
# precisely instead of reporting "no archive found".
release_snapshot_archive_regex() {
  printf '^couchcoop-snapshot-[0-9a-f]+\\.zip$\n'
}
