#!/bin/bash
# 一键启动 pi-token-stats 看板（macOS 双击运行 / 终端 bash 运行皆可）
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PIDFILE="$DIR/.server.pid"
PORT="${PORT:-32022}"
LOG="$DIR/server.log"

# 已在运行则跳过
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "✅ 服务器已在运行 (PID $(cat "$PIDFILE"))"
  echo "   打开: http://localhost:$PORT"
  open "http://localhost:$PORT"
  exit 0
fi

# 优先用 WorkBuddy 自带的 node，找不到就退回系统 node
NODE_BIN="/Users/liuyang/.workbuddy/binaries/node/versions/22.22.2/bin/node"
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="node"; fi

export PORT="$PORT"
export PI_SESSIONS_DIR="${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}"

echo "🚀 正在启动 pi-token-stats ..."
nohup "$NODE_BIN" --experimental-strip-types src/server.ts > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
disown 2>/dev/null || true

sleep 1
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "✅ 已启动 (PID $(cat "$PIDFILE"))  端口 $PORT"
  curl -s -o /dev/null -w "   健康检查: HTTP %{http_code}\n" "http://localhost:$PORT/" 2>/dev/null || true
  echo "   打开: http://localhost:$PORT"
  open "http://localhost:$PORT"
else
  echo "❌ 启动失败，查看日志: $LOG"
fi
