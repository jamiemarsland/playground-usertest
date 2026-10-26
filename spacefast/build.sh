#!/usr/bin/env bash
#
# Assemble the directory Spacefast publishes: sf.jsonc and the worker, and
# nothing else. Publishing the worker/ folder directly would serve package.json
# and the test suite as static files alongside the service.
#
#   ./build.sh          -> dist/
#   ./build.sh --publish

set -euo pipefail
cd "$(dirname "$0")"

# Keep dist/.spacefast: it is what says which space this folder publishes to.
mkdir -p dist
rm -f dist/sf.jsonc dist/worker.js
cp sf.jsonc dist/

# The card that websites load from /card.js rides inside the worker, so the
# published worker is still the only file. plugin/card.js goes in place of the
# /*@card*/null marker.
node -e '
  const fs = require("fs");
  const w = fs.readFileSync("../worker/worker.js", "utf8");
  const card = fs.readFileSync("../plugin/card.js", "utf8");
  if (!w.includes("/*@card*/null")) throw new Error("worker.js has no /*@card*/null marker");
  fs.writeFileSync("dist/worker.js", w.replace("/*@card*/null", () => JSON.stringify(card)));
'

# Only these two files: a runtime takes every request, so anything else
# published here would be uploaded and never served.

echo "dist/ ready:"
ls -1 dist

if [ "${1:-}" = "--publish" ]; then
  shift
  npx --yes spacefast@latest publish dist "$@"
fi
