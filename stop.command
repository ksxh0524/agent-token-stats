#!/bin/bash
# 一键关闭 pi-token-stats 看板（macOS 双击运行 / 终端 bash 运行皆可）
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.server.pid"
stopped=0

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "🛑 已停止服务器 (PID $PID)"
    stopped=1
  else
    echo "ℹ️  PID $PID 已不存在（进程已退出）"
  fi
  rm -f "$PIDFILE"
fi

# 兜底：PID 文件丢失但进程仍在时，精确匹配本项目路径的 server 进程
if [ "$stopped" -eq 0 ]; then
  if pkill -f "pi-token-stats/src/server.ts" 2>/dev/null; then
    echo "🛑 已通过 pkill 停止残留进程"
  else
    echo "ℹ️  没有运行中的服务器"
  fi
fi
