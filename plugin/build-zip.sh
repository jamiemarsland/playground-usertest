#!/usr/bin/env bash
#
# Build the card plugin zip that the Worker's blueprint route points every test
# at. Playground installs it by URL, so the zip has to contain one folder with
# the plugin inside it — a bare pair of files at the root will not activate.
#
#   ./build-zip.sh            -> dist/playground-usertest-card.zip
#
# Upload the result as a release asset at the URL in worker/wrangler.jsonc
# (PLUGIN_ZIP_URL). Every test installs whatever is there at the time, so a fix
# to the card reaches everybody's next tester with no redeploy.

set -euo pipefail
cd "$(dirname "$0")"

NAME=playground-usertest-card
OUT=dist/$NAME.zip

rm -rf dist "$NAME"
mkdir -p dist "$NAME"
cp playground-usertest.php card.js "$NAME/"

zip -qr "$OUT" "$NAME"
rm -rf "$NAME"

echo "$OUT"
unzip -l "$OUT"
