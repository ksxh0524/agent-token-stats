#!/usr/bin/env bash
# agent-token-stats 服务管理器 —— 规范入口为 manager.sh（manager.command 为兼容符号链接）。
# agent / 脚本请用 ./manager.sh；用户双击用 start.command / stop.command（薄封装，会打开浏览器）。
#
# 用法: ./manager.sh <start|stop|restart|status> [选项]
#   start     启动后端（已在跑则跳过），等 /health 通过才返回
#   stop      停止（PID 文件 → 进程匹配 → 端口占用，三层兜底），等端口释放
#   restart   stop 然后 start
#   status    查看状态；退出码 0=运行中 3=未运行 4=进程在但 /health 不通
#
# 选项:
#   --open    启动/重启成功后打开浏览器（仅 start / restart 有效，默认不开）
#   --json    status 输出一行 JSON
#   --wait N  健康检查等待秒数（默认 10）
#   -h        帮助
#
# 环境变量: PORT(默认 32022)  NODE_BIN(默认 node)  PI_SESSIONS_DIR  OPENCODE_DB

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.server.pid"
LOG="$DIR/server.log"
PORT="${PORT:-32022}"
NODE_BIN="${NODE_BIN:-node}"
BASE="http://localhost:$PORT"
WAIT=10
OPEN=0
JSON=0

# 帮助 = 脚本开头 shebang 之后的那段连续注释
usage() {
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
}

health() { curl -sf -o /dev/null --max-time 2 "$BASE/health"; }
# PID 文件里还活着的进程
pidfile_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}
# 占用端口的进程（PID 文件失效时的兜底）
port_pid() { lsof -ti tcp:"$PORT" 2>/dev/null | head -1; }

# ---------- start ----------
do_start() {
  local pid
  if pid="$(pidfile_pid)"; then
    echo "ℹ️  服务已在运行 (PID $pid)，跳过启动"
    [ "$OPEN" -eq 1 ] && { open "$BASE"; echo "   已打开 $BASE"; }
    return 0
  fi
  if health; then
    echo "ℹ️  端口 $PORT 已有服务在运行，未重复启动（如需重启用 restart）"
    [ "$OPEN" -eq 1 ] && { open "$BASE"; echo "   已打开 $BASE"; }
    return 0
  fi
  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "❌ 未找到 node: $NODE_BIN（需要 >= 22.6；可用 NODE_BIN=/path/to/node 指定）"
    return 1
  fi

  export PORT
  export PI_SESSIONS_DIR="${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}"

  # 脱离当前进程组启动：否则调用方（终端/脚本/工具）退出时服务会被一并回收。
  # macOS 没有 setsid，用 perl fork+setsid 兜底。
  if command -v setsid >/dev/null 2>&1; then
    setsid "$NODE_BIN" --experimental-strip-types "$DIR/src/server.ts" > "$LOG" 2>&1 < /dev/null &
  elif command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'exit(0) if fork(); POSIX::setsid(); exec(@ARGV);' \
      "$NODE_BIN" --experimental-strip-types "$DIR/src/server.ts" > "$LOG" 2>&1 < /dev/null &
  else
    nohup "$NODE_BIN" --experimental-strip-types "$DIR/src/server.ts" > "$LOG" 2>&1 < /dev/null &
    disown 2>/dev/null || true
  fi

  local i=0 pid
  while [ "$i" -lt "$WAIT" ]; do
    sleep 1
    i=$((i + 1))
    if health; then
      # pid 从端口反查：脱离进程组后 $! 拿到的是中间进程，不可靠
      pid="$(port_pid)"
      [ -n "$pid" ] && echo "$pid" > "$PIDFILE"
      echo "✅ 已启动 (PID ${pid:-未知})  端口 $PORT"
      [ "$OPEN" -eq 1 ] && { open "$BASE"; echo "   已打开 $BASE"; }
      return 0
    fi
  done
  echo "❌ 启动超时（${WAIT}s 内 /health 未通过），最新日志:"
  tail -5 "$LOG" 2>/dev/null
  return 1
}

# ---------- stop ----------
do_stop() {
  local stopped=0 pid pp
  if pid="$(pidfile_pid)"; then
    if kill "$pid" 2>/dev/null; then
      echo "🛑 已停止 (PID $pid)"
      stopped=1
    fi
  fi
  rm -f "$PIDFILE"

  if [ "$stopped" -eq 0 ] && pkill -f "$DIR/src/server.ts" 2>/dev/null; then
    echo "🛑 已停止残留进程（进程名匹配）"
    stopped=1
  fi

  if [ "$stopped" -eq 0 ]; then
    pp="$(port_pid)"
    if [ -n "$pp" ] && kill $pp 2>/dev/null; then
      echo "🛑 已停止占用端口 $PORT 的进程 (PID $pp)"
      stopped=1
    fi
  fi

  # 等端口真正释放，restart 才不会撞上
  local i=0
  while [ "$i" -lt 20 ]; do
    [ -z "$(port_pid)" ] && break
    sleep 0.5
    i=$((i + 1))
  done

  if [ "$stopped" -eq 0 ]; then
    echo "ℹ️  没有运行中的服务器"
  fi
  return 0
}

# ---------- status ----------
do_status() {
  local state=stopped pid="" uptime=""
  pid="$(pidfile_pid)" || pid="$(port_pid)"
  if [ -n "$pid" ]; then
    if health; then
      state=running
      local body
      body="$(curl -sf --max-time 2 "$BASE/health" 2>/dev/null)" || body=""
      uptime="$(printf '%s' "$body" | grep -o '"uptime":[0-9.]*' | head -1 | cut -d: -f2)"
      [ -n "$uptime" ] && uptime="$(printf '%.0f' "$uptime")"
    else
      state=unhealthy
    fi
  fi

  if [ "$JSON" -eq 1 ]; then
    printf '{"state":"%s","pid":%s,"port":%s,"uptime":%s,"url":"%s"}\n' \
      "$state" "${pid:-null}" "$PORT" "${uptime:-null}" "$BASE"
  else
    case "$state" in
      running)
        if [ -n "$uptime" ]; then
          echo "✅ 运行中  PID $pid  端口 $PORT  已运行 ${uptime}s  $BASE"
        else
          echo "✅ 运行中  PID $pid  端口 $PORT  $BASE"
        fi ;;
      unhealthy) echo "⚠️  进程在 (PID $pid) 但 /health 不通  端口 $PORT  日志: $LOG" ;;
      *) echo "⚪ 未运行  端口 $PORT 空闲" ;;
    esac
  fi

  case "$state" in
    running) return 0 ;;
    unhealthy) return 4 ;;
    *) return 3 ;;
  esac
}

# ---------- 参数解析 ----------
# -h 优先：允许它出现在任意位置
for a in "$@"; do
  case "$a" in
    -h | --help) usage; exit 0 ;;
  esac
done
ACTION="${1:-}"
if [ $# -gt 0 ]; then shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --open) OPEN=1 ;;
    --json) JSON=1 ;;
    --wait) shift; WAIT="${1:-10}" ;;
    -h | --help) usage; exit 0 ;;
    *) echo "❌ 未知参数: $1"; echo; usage; exit 2 ;;
  esac
  shift
done

case "$ACTION" in
  start) do_start ;;
  stop) do_stop ;;
  restart)
    do_stop
    do_start
    ;;
  status) do_status ;;
  "")
    echo "❌ 缺少动作"; echo; usage; exit 2 ;;
  *)
    echo "❌ 未知动作: $ACTION"; echo; usage; exit 2 ;;
esac
