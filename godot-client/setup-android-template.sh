#!/usr/bin/env bash
# Install + patch the Android gradle build template for the CouchCoop Godot client.
#
# The template (godot-client/android/build/, ~700MB of gradle sources + godot-lib AARs) is generated
# from the installed export templates and is NOT committed — run this once per checkout before the
# first `--export-debug "Android"`. It also applies the load-bearing cleartext patch: the client talks
# plain ws://+http:// to the host on the LAN, which Android 9+ blocks unless the manifest opts in
# (a per-domain network-security-config cannot work here: the host LAN IP is unknown ahead of time and
# headlessMirrorPort redirects to arbitrary 13347+ ports).
#
# Prereqs (see README.md "Android export recipe"): Godot 4.5.1 mono export templates installed under
# ~/.local/share/godot/export_templates/4.5.1.stable.mono/
set -euo pipefail
cd "$(dirname "$0")"

TEMPLATES="${GODOT_EXPORT_TEMPLATES:-$HOME/.local/share/godot/export_templates/4.5.1.stable.mono}"
SRC="$TEMPLATES/android_source.zip"
[[ -f "$SRC" ]] || { echo "ERROR: $SRC not found — install the 4.5.1 mono export templates first." >&2; exit 1; }

mkdir -p android/build
unzip -q -o "$SRC" -d android/build
echo "4.5.1.stable.mono" > android/.build_version

# Load-bearing: without a .gdignore, Godot's filesystem scanner walks the gradle tree; every export
# then re-copies its own previous asset copies (android/build/assets, build/intermediates) into the
# APK as recursively-nested phantom entries and spams "Can't open file" errors.
touch android/build/.gdignore

MANIFEST=android/build/AndroidManifest.xml
if ! grep -q 'usesCleartextTraffic' "$MANIFEST"; then
  sed -i 's|<application|<application\n        android:usesCleartextTraffic="true"|' "$MANIFEST"
fi
grep -q 'android:usesCleartextTraffic="true"' "$MANIFEST" || { echo "ERROR: cleartext patch failed" >&2; exit 1; }
echo "Android build template installed + cleartext patch applied."
