#!/bin/sh
# Creates the self-signed code signing identity "aside local signing" in the login keychain, once. app/build.sh signs
# with it, so a rebuilt app keeps its Microphone and Screen Recording grants. Needs Homebrew OpenSSL 3: the system
# LibreSSL has no -legacy, and without it the keychain cannot read the .p12.
set -e
ID="aside local signing"
if security find-identity -p codesigning | grep -q "$ID"; then echo "\"$ID\" already exists."; exit 0; fi
SSL=/opt/homebrew/bin/openssl
[ -x "$SSL" ] || { echo "Install OpenSSL 3 first: brew install openssl@3"; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"$SSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$ID" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning"
"$SSL" pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/id.p12" -passout pass:aside
security import "$TMP/id.p12" -k ~/Library/Keychains/login.keychain-db -P aside -T /usr/bin/codesign
echo "Created \"$ID\". Build the app with: npm run build:app"
