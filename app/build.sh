#!/bin/sh
# Builds ~/Applications/aside.app with swiftc (no Xcode) and signs it. A stable signature keeps the Microphone and
# Screen Recording grants across rebuilds. Create the identity once with: sh app/make-cert.sh
set -e
cd "$(dirname "$0")/.."
APP="$HOME/Applications/aside.app"
ID="aside local signing"
mkdir -p "$APP/Contents/MacOS" bin
[ -x bin/aside-capture ] || npm run -s build:capture
swiftc -O -swift-version 5 app/main.swift app/Server.swift app/Detect.swift app/Hotkeys.swift app/Windows.swift app/Logic.swift -o "$APP/Contents/MacOS/aside"
sed -e "s|@ROOT@|$PWD|" -e "s|@VERSION@|$(node -p "require('./package.json').version")|" app/Info.plist > "$APP/Contents/Info.plist"
if security find-identity -p codesigning | grep -q "$ID"; then codesign --force --sign "$ID" "$APP"
else echo "No \"$ID\" identity, so the app is signed ad hoc and loses its permissions on every rebuild. Run: sh app/make-cert.sh"; codesign --force --sign - "$APP"; fi
echo "Built $APP"
