#!/bin/zsh

set -e

cd "$(dirname "$0")"

PORT=5173
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

URL="http://127.0.0.1:$PORT/"

echo "Starting resume screening tool..."
echo "Project directory: $(pwd)"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies for first run..."
  npm install
fi

echo "Opening: $URL"
(sleep 2 && open "$URL") &

npm run dev -- --host 127.0.0.1 --port "$PORT"
