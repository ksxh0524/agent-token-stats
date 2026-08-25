#!/bin/bash
# 一键启动 pi-token-stats 看板（macOS 双击运行 / 终端 bash 运行皆可）
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

PIDFILE="$DIR/.server.pid"
PORT="${PORT:-32022}"
LOG="$DIR/server.log"

# 已在运行则直接打开页面
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "✅ 服务器已在运行 (PID $(cat "$PIDFILE"))"
  echo "   打开: http://localhost:$PORT"
  open "http://localhost:$PORT"
  exit 0
fi

# node 查找顺序：环境变量 NODE_BIN → PATH 中的 node
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "❌ 未找到 node（需要 >= 22.6，支持 --experimental-strip-types）"
  echo "   可用 export NODE_BIN=/path/to/node 指定路径后重试"
  exit 1
fi

export PORT
export PI_SESSIONS_DIR="${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}"

echo "🚀 正在启动 pi-token-stats ..."
nohup "$NODE_BIN" --experimental-strip-types src/server.ts > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
disown 2>/dev/null || true

# 健康检查：最多等 5 秒
ok=0
for _ in 1 2 3 4 5; do
  sleep 1
  if curl -sf -o /dev/null "http://localhost:$PORT/health"; then
    ok=1
    break
  fi
done

if [ "$ok" -eq 1 ]; then
  echo "✅ 已启动 (PID $(cat "$PIDFILE"))  端口 $PORT"
  echo "   打开: http://localhost:$PORT"
  open "http://localhost:$PORT"
else
  echo "❌ 启动失败（端口被占用或 node 版本过低），查看日志: $LOG"
  tail -5 "$LOG" 2>/dev/null
fi
