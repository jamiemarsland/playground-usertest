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

rm -rf dist
mkdir -p dist
cp sf.jsonc ../worker/worker.js dist/

# Only these two files: a runtime takes every request, so anything else
# published here would be uploaded and never served.

echo "dist/ ready:"
ls -1 dist

if [ "${1:-}" = "--publish" ]; then
  shift
  npx --yes spacefast@latest publish dist "$@"
fi
