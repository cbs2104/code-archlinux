#!/usr/bin/env bash
# Builds a single-file Flatpak bundle from the electron-builder --dir output.
# This intentionally uses flatpak's own build-init/export/bundle commands
# instead of flatpak-builder: DeskPet bundles its own Electron runtime, so no
# compilation SDK is needed, only the GNOME runtime for its libraries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID=com.deskpet.app
ARCH=x86_64
RUNTIME="${FLATPAK_RUNTIME:-org.gnome.Platform}"
RUNTIME_VERSION="${FLATPAK_RUNTIME_VERSION:-50}"
SDK="${FLATPAK_SDK:-$RUNTIME}"
UNPACKED="$ROOT/release/linux-unpacked"
BUILD="${FLATPAK_BUILD_DIR:-$ROOT/release/.flatpak-build}"
REPO="${FLATPAK_REPO_DIR:-$ROOT/release/.flatpak-repo}"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json")"
OUT="${FLATPAK_OUTPUT:-$ROOT/release/DeskPet-${VERSION}-${ARCH}.flatpak}"

if ! command -v flatpak >/dev/null 2>&1; then
  echo "flatpak is required. Install it (Arch: sudo pacman -S flatpak)." >&2
  exit 1
fi

if [[ ! -x "$UNPACKED/deskpet" ]]; then
  echo "Missing $UNPACKED/deskpet." >&2
  echo "Run: npm run pack:dir" >&2
  exit 1
fi

if ! flatpak info --user "$RUNTIME/$ARCH/$RUNTIME_VERSION" >/dev/null 2>&1 \
  && ! flatpak info --system "$RUNTIME/$ARCH/$RUNTIME_VERSION" >/dev/null 2>&1; then
  echo "Runtime $RUNTIME/$ARCH/$RUNTIME_VERSION is not installed." >&2
  echo "Install it from Flathub, e.g. flatpak install flathub \"$RUNTIME//$RUNTIME_VERSION\"" >&2
  exit 1
fi

rm -rf "$BUILD" "$REPO"
trap 'rm -rf "$BUILD" "$REPO"' EXIT

flatpak build-init --arch="$ARCH" "$BUILD" "$APP_ID" "$SDK" "$RUNTIME" "$RUNTIME_VERSION"

mkdir -p \
  "$BUILD/files/bin" \
  "$BUILD/files/share/applications" \
  "$BUILD/files/share/icons/hicolor/512x512/apps"

cp -a "$UNPACKED" "$BUILD/files/deskpet"

cat > "$BUILD/files/bin/deskpet" <<'SH'
#!/bin/sh
exec /app/deskpet/deskpet --ozone-platform=x11 --no-sandbox "$@"
SH
chmod 755 "$BUILD/files/bin/deskpet"

cat > "$BUILD/files/share/applications/$APP_ID.desktop" <<DESKTOP
[Desktop Entry]
Name=DeskPet
Comment=A desktop pet for Linux
Exec=deskpet --ozone-platform=x11 %U
Icon=$APP_ID
Terminal=false
Type=Application
Categories=Utility;Game;
StartupWMClass=deskpet
X-GNOME-UsesNotifications=true
DESKTOP

if command -v magick >/dev/null 2>&1; then
  magick "$ROOT/build/icon.png" -resize 512x512 \
    "$BUILD/files/share/icons/hicolor/512x512/apps/$APP_ID.png"
elif command -v convert >/dev/null 2>&1; then
  convert "$ROOT/build/icon.png" -resize 512x512 \
    "$BUILD/files/share/icons/hicolor/512x512/apps/$APP_ID.png"
else
  cp "$ROOT/build/icon.png" "$BUILD/files/share/icons/hicolor/512x512/apps/$APP_ID.png"
fi

flatpak build-finish "$BUILD" \
  --share=ipc \
  --socket=x11 \
  --socket=pulseaudio \
  --device=dri \
  --share=network \
  --filesystem=home \
  --filesystem=xdg-config/autostart:create \
  --talk-name=org.freedesktop.Notifications \
  --talk-name=org.freedesktop.portal.Desktop \
  --talk-name=org.freedesktop.Speech.Dispatcher \
  --talk-name=org.kde.StatusNotifierWatcher

flatpak build-export "$REPO" "$BUILD"
mkdir -p "$(dirname "$OUT")"
flatpak build-bundle "$REPO" "$OUT" "$APP_ID"

echo "Built $OUT"
