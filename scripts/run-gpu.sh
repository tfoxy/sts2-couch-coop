#!/bin/bash
# Run a GPU-needing (headed) bench/probe command on a VIRTUAL display.
#
# This box is somebody's workstation: a headed Chrome opened for a bench run lands on their screen. A
# headed run needs a window, not the user's monitor — ANGLE/vulkan reaches the real GPU from any X
# display (gsw's real-GPU `test:canvas-pixel` gate is the precedent) — so every `--headed --gpu vulkan`
# bench and every `PROBE_HEADED=1` probe goes through here. See docs/mirror-combat-bench.md ("Headed
# runs go under xvfb").
#
# The screen is sized above the largest viewport any run asks for (2520x1080 wide-screen probes), and
# `-a` picks a free display so sequential runs never collide.
#
#   scripts/run-gpu.sh node scripts/bench-mirror-replay.mjs --headed --gpu vulkan ...
#   scripts/run-gpu.sh env PROBE_HEADED=1 PROBE_CHROME_ARGS="--use-angle=vulkan" node scripts/probe-....mjs ...
set -euo pipefail
if [ $# -eq 0 ]; then
  echo "usage: scripts/run-gpu.sh <command...>" >&2
  exit 2
fi
# THE WAYLAND TRAP, and why plain xvfb-run was not enough on this box: xvfb-run sets DISPLAY (X11) but
# leaves WAYLAND_DISPLAY alone, and Chrome's Ozone auto-detection PREFERS Wayland — so the window sailed
# straight past the virtual display onto the user's real compositor. Unset it (and the session-type hint)
# so Ozone falls back to X11, where DISPLAY now points at the Xvfb screen nobody is looking at.
exec env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a -s "-screen 0 2560x1440x24" "$@"
