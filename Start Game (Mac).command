#!/bin/bash
# Double-click to start the game (the first time: right-click > Open).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed yet. It's free and needed to run the game."
  echo "  Your browser will now open the download page. Install the \"LTS\" version,"
  echo "  then double-click this file again."
  echo
  open "https://nodejs.org/"
  read -r -p "Press Enter to close this window."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Getting the game ready for the first time, this takes a minute..."
  npm install --omit=dev
fi
(sleep 2 && open "http://localhost:3000") &
npm start
