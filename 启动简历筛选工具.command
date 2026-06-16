#!/bin/zsh

set -e

cd "$(dirname "$0")"

PORT=5173
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

URL="http://127.0.0.1:$PORT/"

echo "正在启动简历查看筛选工具..."
echo "项目目录：$(pwd)"

if [ ! -d "node_modules" ]; then
  echo "首次运行，正在安装依赖..."
  npm install
fi

echo "浏览器即将打开：$URL"
(sleep 2 && open "$URL") &

npm run dev -- --host 127.0.0.1 --port "$PORT"
