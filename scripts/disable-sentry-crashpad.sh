#!/usr/bin/env bash
# Disable the STS2 Sentry crash handler for scripted headless runs.
#
# Why: on a headless instance driven by a script, entering the Act-2 (Hive)
# Ancient event makes Sentry's crashpad_handler escalate a benign, otherwise-
# survivable signal into a process kill (the game survives the same event once
# crashpad is moved aside). An unattended run has no use for crash reporting,
# so we disable it. Idempotent; safe to re-run. Reverse with
# scripts/enable-sentry-crashpad.sh (or rename the .disabled files back).
set -euo pipefail

GAME_DIR="${STS2_GAME_DIR:-$HOME/.local/share/Steam/steamapps/common/Slay the Spire 2}"
GAME_DIRS=(
  "$GAME_DIR"
  "/mnt/media-ext/Steam/steamapps/common/Slay the Spire 2"
)

disabled_any=0
for dir in "${GAME_DIRS[@]}"; do
  cp="$dir/crashpad_handler"
  if [ -f "$cp" ]; then
    mv "$cp" "$cp.disabled"
    echo "disabled: $cp"
    disabled_any=1
  elif [ -f "$cp.disabled" ]; then
    echo "already disabled: $cp"
    disabled_any=1
  fi
done

if [ "$disabled_any" = 0 ]; then
  echo "no crashpad_handler found under known game dirs (nothing to do)"
fi
