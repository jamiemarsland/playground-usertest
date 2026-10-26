#!/usr/bin/env bash
#
# Assemble the directory Spacefast publishes: sf.jsonc and the worker, and
# nothing else. Publishing the worker/ folder directly would serve package.json
# and the test suite as static files alongside the service.
#
#   ./build.sh          -> dist/
#   ./build.sh --publish
#
# The same app has two front doors. FRONT=web builds the one for any website
# (its own home page, task sets, llms.txt and tools); the default is the
# WordPress one. OUT picks the folder, so each front door keeps its own
# .spacefast state:
#
#   FRONT=web OUT=~/gogh/spacefast-usertest-web-trial ./build.sh

set -euo pipefail
cd "$(dirname "$0")"

OUT="${OUT:-dist}"
FRONT="${FRONT:-wordpress}"
case "$FRONT" in wordpress|web) ;; *) echo "FRONT is wordpress or web" >&2; exit 1 ;; esac

# Keep $OUT/.spacefast: it is what says which space this folder publishes to.
mkdir -p "$OUT"
rm -f "$OUT/sf.jsonc" "$OUT/worker.js"
cp sf.jsonc "$OUT/"

# The card that websites load from /card.js rides inside the worker, so the
# published worker is still the only file. plugin/card.js goes in place of the
# /*@card*/null marker.
node -e '
  const fs = require("fs");
  const [out, front] = process.argv.slice(1);
  const w = fs.readFileSync("../worker/worker.js", "utf8");
  const card = fs.readFileSync("../plugin/card.js", "utf8");
  if (!w.includes("/*@card*/null")) throw new Error("worker.js has no /*@card*/null marker");
  if (!w.includes("/*@front*/\x27wordpress\x27")) throw new Error("worker.js has no front-door marker");
  fs.writeFileSync(out + "/worker.js", w
    .replace("/*@card*/null", () => JSON.stringify(card))
    .replace("/*@front*/\x27wordpress\x27", () => JSON.stringify(front)));
' "$OUT" "$FRONT"
if [ "$FRONT" = web ]; then sed -i.bak 's/"name": "Playground user testing"/"name": "Website user testing"/' "$OUT/sf.jsonc" && rm -f "$OUT/sf.jsonc.bak"; fi

# Only these two files: a runtime takes every request, so anything else
# published here would be uploaded and never served.

echo "$OUT ready ($FRONT front door):"
ls -1 "$OUT"

if [ "${1:-}" = "--publish" ]; then
  shift
  npx --yes spacefast@latest publish "$OUT" "$@"
fi
