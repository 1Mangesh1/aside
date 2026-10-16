#!/bin/sh
# Builds ~/Applications/aside.app with swiftc (no Xcode) and signs it. A stable signature keeps the Microphone and
# Screen Recording grants across rebuilds. Create the identity once with: sh app/make-cert.sh
set -e
cd "$(dirname "$0")/.."
APP="$HOME/Applications/aside.app"
ID="aside local signing"
mkdir -p "$APP/Contents/MacOS" bin
[ -d node_modules ] || npm install --silent
[ -x bin/aside-capture ] || npm run -s build:capture
swiftc -O -swift-version 5 -target arm64-apple-macos14.4 app/main.swift app/Server.swift app/Detect.swift app/Hotkeys.swift app/Windows.swift app/Logic.swift -o "$APP/Contents/MacOS/aside"
PLIST="$APP/Contents/Info.plist"
cp app/Info.plist "$PLIST"
# plutil, not sed: it escapes a path that has & or < in it.
plutil -replace AsideRoot -string "$PWD" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$(node -p "require('./package.json').version")" "$PLIST"
if security find-identity -p codesigning | grep -q "$ID"; then codesign --force --sign "$ID" "$APP"
else echo "No \"$ID\" identity, so the app is signed ad hoc and loses its permissions on every rebuild. Run: sh app/make-cert.sh"; codesign --force --sign - "$APP"; fi
echo "Built $APP"
