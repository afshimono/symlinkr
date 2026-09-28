#!/bin/sh
# Install Symlinkr into Herdr from the GitHub default branch.
# There is no compile step: Herdr clones the repo and runs it with Node.
set -eu

if ! command -v herdr >/dev/null 2>&1; then
  echo "herdr is not installed. Install Herdr first: https://herdr.dev" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 20 ]; then
  echo "Node.js 20 or newer is required (found $(node -v))." >&2
  exit 1
fi

exec herdr plugin install afshimono/symlinkr --yes
