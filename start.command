#!/bin/bash
# Double-click this file to start the Lead Finder dashboard.
set -e
cd "$(dirname "$0")"

# Pre-flight cleanup: remove any stray build-cache directories at the
# project root. The real Turbopack cache lives in $TMPDIR (see
# next.config.ts). A stray ./var/ at the project root has caused Tailwind
# CSS parse errors in the past — Tailwind scans it and chokes on the
# binary .sst cache files. Always clean before booting.
if [ -d "./var" ]; then
  echo "Removing stray build cache at ./var ..."
  rm -rf ./var
fi
if [ -d "./.next" ]; then
  echo "Removing stale ./.next ..."
  rm -rf ./.next
fi

# Make sure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Open the browser shortly after the server boots
( sleep 4 && open "http://localhost:3000" ) &

npm run dev
