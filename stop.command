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

# 兜底：PID 文件丢失但进程仍在时，按命令行特征清理
if [ "$stopped" -eq 0 ]; then
  if pkill -f "src/server.ts" 2>/dev/null; then
    echo "🛑 已通过 pkill 停止残留进程"
  else
    echo "ℹ️  没有运行中的服务器"
  fi
fi

# 端口随进程退出自动释放，无需额外清理（原先硬编码端口的兜底从不命中，已移除）
