#!/usr/bin/env bash
# Compatibility entry point for offline Windows capture calibration.
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/calibrate-capture.sh" --platform windows "$@"
