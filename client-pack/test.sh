#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/build.sh"
EDITOR="${COUCH_PACK_GODOT:-$(mise where godot@4.5.1-stable)/Godot_v4.5.1-stable_linux.x86_64}"
mkdir -p "$HERE/build/project/tests"
cp "$HERE/tests/offline.gd" "$HERE/build/project/tests/"
python3 "$HERE/tests/fake_host.py" "$EDITOR" "$HERE/build/project" "$HERE/build"
node "$HERE/../frontend/node_modules/vitest/vitest.mjs" run --config "$HERE/tests/vitest.config.mts"
