#!/usr/bin/env bash
# Re-enable the STS2 Sentry crash handler (reverse of disable-sentry-crashpad.sh).
set -euo pipefail

GAME_DIR="${STS2_GAME_DIR:-$HOME/.local/share/Steam/steamapps/common/Slay the Spire 2}"
GAME_DIRS=(
  "$GAME_DIR"
  "/mnt/media-ext/Steam/steamapps/common/Slay the Spire 2"
)

for dir in "${GAME_DIRS[@]}"; do
  cp="$dir/crashpad_handler"
  if [ -f "$cp.disabled" ]; then
    mv "$cp.disabled" "$cp"
    echo "re-enabled: $cp"
  fi
done
