#!/usr/bin/env bash
# agent-token-stats 服务管理器 —— 规范入口为 manager.sh。
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
# 端口上的【监听者】。必须带 -sTCP:LISTEN：不带时 lsof 会把连到这个端口的
# 客户端（浏览器、curl、编辑器）一起列出来，stop 会连它们一并 kill —— 实测过。
# 无占用时输出空，调用方要自己吞返回码，否则 set -e 下脚本会静默退出。
port_pids() { lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }
# 命令行匹配（端口已释放但进程还没死的残留）。用 --experimental-strip-types
# 这个本服务独有的参数当锚点，比只匹配路径更不容易误伤编辑器 / grep 之类。
# [-] 是防模式以 - 开头被 pgrep 当成选项；NODE_BIN 换成 bun/deno 也能匹配上。
name_pids() { pgrep -f "[-]-experimental-strip-types.*$DIR/src/server\.ts" 2>/dev/null || true; }
# 缺了这些工具，健康检查会永远失败、端口兜底会永远为空，直接说清楚比让人干等强
need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ 缺少命令: $1（health 检查和端口查询都依赖它）"
    return 1
  fi
}
# $1 是不是 $2（空格分隔的 PID 串）里的一个
pid_in() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
# 从一批 PID 里筛出还活着的；绝不返回非零，避免被 set -e 打断
alive_of() {
  local p out=""
  for p in $1; do
    [ "$p" = "$$" ] && continue
    if kill -0 "$p" 2>/dev/null; then out="$out $p"; fi
  done
  printf '%s' "${out# }"
}
# 一批 PID 去重合并成一个空格串
uniq_pids() { printf '%s\n' $1 | sed '/^$/d' | sort -un | tr '\n' ' '; }
# --open 时打开浏览器。单独成函数：写成 `[ "$OPEN" -eq 1 ] && ...` 在
# set -e 下条件不成立会让整个脚本静默退出（本脚本踩过的坑）。
open_if_wanted() {
  if [ "$OPEN" -eq 1 ]; then
    open "$BASE"
    echo "   已打开 $BASE"
  fi
}
# node 版本够不够跑 --experimental-strip-types（>= 22.6）。
# 不提前拦的话，版本低只会表现为启动超时，白等 10 秒才知道失败。
node_ok() {
  local v major minor
  v="$("$NODE_BIN" -v 2>/dev/null || true)"
  v="${v#v}"
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  case "$minor" in '' | *[!0-9]*) return 1 ;; esac
  if [ "$major" -gt 22 ]; then return 0; fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 6 ]; then return 0; fi
  return 1
}

# ---------- start ----------
do_start() {
  local pid="" pf="" np="" up=0
  if health; then up=1; fi

  # PID 文件不能盲信：进程死后 PID 会被系统分给别的进程，
  # 那样 start 会以为服务还在跑直接跳过，结果根本没起来。
  pf="$(pidfile_pid || true)"
  if [ -n "$pf" ]; then
    if [ "$up" -eq 1 ]; then
      pid="$pf" # 端口上确实是本服务，pidfile 可信
    else
      np="$(name_pids)"
      if pid_in "$pf" "$np"; then
        pid="$pf" # 命令行对得上，是本服务，只是 health 没通
      else
        echo "⚠️  PID 文件里的 $pf 不是本服务进程（PID 已被复用），已清理"
        rm -f "$PIDFILE"
      fi
    fi
  fi

  if [ -n "$pid" ]; then
    echo "ℹ️  服务已在运行 (PID $pid)，跳过启动"
    open_if_wanted
    return 0
  fi
  if [ "$up" -eq 1 ]; then
    echo "ℹ️  端口 $PORT 已有服务在运行，未重复启动（如需重启用 restart）"
    # PID 文件丢了（上次被强杀 / 手动删过）就顺手补回来，
    # 否则下次 stop 只能靠端口和进程名兜底。
    pid="$(port_pids | head -1)"
    if [ -n "$pid" ]; then echo "$pid" > "$PIDFILE"; fi
    open_if_wanted
    return 0
  fi
  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "❌ 未找到 node: $NODE_BIN（需要 >= 22.6；可用 NODE_BIN=/path/to/node 指定）"
    return 1
  fi
  if ! node_ok; then
    echo "❌ node 版本过低: $("$NODE_BIN" -v 2>/dev/null || echo 未知)（$NODE_BIN）"
    echo "   本项目需要 >= 22.6 才能用 --experimental-strip-types；可用 NODE_BIN=/path/to/node 指定"
    return 1
  fi
  # 端口被别的进程占着（health 又不通）→ 启动必然 EADDRINUSE，别让用户干等超时
  local blocker; blocker="$(uniq_pids "$(port_pids)")"
  if [ -n "$blocker" ]; then
    echo "❌ 端口 $PORT 已被其他进程占用: $blocker"
    echo "   换端口启动: PORT=32100 $0 start"
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

  local i=0
  while [ "$i" -lt "$WAIT" ]; do
    sleep 1
    i=$((i + 1))
    if health; then
      # pid 从端口反查：脱离进程组后 $! 拿到的是中间进程，不可靠。
      # /health 通了但 lsof 可能还没看到监听，多试几次再放弃写 PID 文件。
      local j=0
      while [ "$j" -lt 5 ] && [ -z "$pid" ]; do
        pid="$(port_pids | head -1)"
        [ -n "$pid" ] || sleep 0.2
        j=$((j + 1))
      done
      if [ -n "$pid" ]; then echo "$pid" > "$PIDFILE"; fi
      echo "✅ 已启动 (PID ${pid:-未知})  端口 $PORT"
      open_if_wanted
      return 0
    fi
  done
  echo "❌ 启动超时（${WAIT}s 内 /health 未通过），最新日志:"
  tail -5 "$LOG" 2>/dev/null
  return 1
}

# ---------- stop ----------
do_stop() {
  # 只杀「确认是本服务」的进程。三条线索：命令行 / 端口监听 / PID 文件。
  # 端口监听者必须 /health 通过（说明端口上确实是本服务）才并入名单，
  # 否则端口上可能是别的服务，不能替用户做主把它杀掉。
  local p pids="" pf blocker="" np="" hp=""
  np="$(name_pids)"
  for p in $np; do pids="$pids $p"; done

  if health; then
    hp="$(port_pids)"
    for p in $hp; do pids="$pids $p"; done
  else
    # health 不通：端口上的东西不是本服务，只记下来报告，不碰
    blocker="$(uniq_pids "$(port_pids)")"
  fi

  pf="$(pidfile_pid || true)"
  if [ -n "$pf" ]; then
    # PID 文件不可全信：进程退出后 PID 可能被系统分给别的进程。
    # 只有「命令行匹配」或「本服务还在应答」时才认为它真是我们的服务。
    if pid_in "$pf" "$np" || [ -n "$hp" ]; then
      pids="$pids $pf"
    else
      echo "⚠️  PID 文件里的 $pf 不是本服务进程（PID 可能已被复用），跳过不杀"
    fi
  fi
  pids="$(uniq_pids "$pids")"

  if [ -n "$pids" ]; then
    echo "⏹  正在停止: $pids"
    for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  elif [ -n "$blocker" ]; then
    echo "ℹ️  本服务没在跑；端口 $PORT 被其他进程占用: $blocker（未动它）"
  else
    echo "ℹ️  没有运行中的服务器（端口 $PORT 空闲）"
  fi
  rm -f "$PIDFILE"

  # 最多等 5s 让它优雅退出，每 0.25s 查一次
  local i=0 alive
  while [ "$i" -lt 20 ]; do
    alive="$(alive_of "$pids")"
    if [ -z "$alive" ]; then break; fi
    sleep 0.25
    i=$((i + 1))
  done

  # 还赖着不走的强杀 —— 这是「点完 stop 进程还卡着」的根因兜底
  alive="$(alive_of "$pids")"
  if [ -n "$alive" ]; then
    echo "⚠️  以下进程未响应 SIGTERM，强制结束: $alive"
    for p in $alive; do kill -KILL "$p" 2>/dev/null || true; done
    sleep 0.4
  fi

  # 端口兜底：只有确认刚才停的是本服务时才敢对端口占用者下手，
  # 从头到尾 health 就不通的情况（端口上是别人的服务）一个都不碰。
  local left; left="$(uniq_pids "$(port_pids)")"
  if [ -n "$left" ] && { [ -n "$np" ] || [ -n "$hp" ]; }; then
    echo "⚠️  端口 $PORT 仍被占用，强制结束: $left"
    for p in $left; do kill -KILL "$p" 2>/dev/null || true; done
    sleep 0.4
  fi

  # blocker 场景上面已经报过了，这里不再重复
  left="$(uniq_pids "$(port_pids)")"
  if [ -n "$left" ] && [ -z "$blocker" ]; then
    echo "❌ 仍有进程占用端口 $PORT: $left（强制结束也没成功）"
    return 1
  fi
  if [ -n "$pids" ]; then echo "✅ 已停止，端口 $PORT 已释放"; fi
  return 0
}

# ---------- status ----------
do_status() {
  local state=stopped pid="" uptime=""
  pid="$(pidfile_pid || true)"
  if [ -z "$pid" ]; then pid="$(port_pids | head -1)"; fi
  if [ -n "$pid" ]; then
    if health; then
      state=running
      local body
      body="$(curl -sf --max-time 2 "$BASE/health" 2>/dev/null)" || body=""
      uptime="$(printf '%s' "$body" | grep -o '"uptime":[0-9.]*' | head -1 | cut -d: -f2)"
      if [ -n "$uptime" ]; then uptime="$(printf '%.0f' "$uptime")"; fi
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
    --wait)
      if [ $# -lt 2 ]; then
        echo "❌ --wait 缺少数值参数（例: --wait 20）"
        exit 2
      fi
      shift
      WAIT="$1"
      case "$WAIT" in
        '' | *[!0-9]*)
          echo "❌ --wait 需要一个非负整数: $WAIT"
          exit 2
          ;;
      esac
      ;;
    -h | --help) usage; exit 0 ;;
    *) echo "❌ 未知参数: $1"; echo; usage; exit 2 ;;
  esac
  if [ $# -gt 0 ]; then shift; fi
done

# curl 做健康检查、lsof 查端口，缺一个后面的分支就全是假阴性
for t in curl lsof; do
  if ! need_tool "$t"; then exit 1; fi
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
