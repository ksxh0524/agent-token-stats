#!/bin/bash
# 关闭「调用方所在的那个 Terminal 标签页」——只关自己这个，不动别的窗口/标签。
# 双击 .command 时窗口不会自己消失，start.command / stop.command 跑完调它收尾。
#
# 用法: "$(dirname "$0")/.close-window.sh" [关闭前等待秒数，默认 1.5]
# 跳过: ATS_KEEP_WINDOW=1
# 只在 Terminal.app 下生效；iTerm2 / 其他终端 / 非交互环境一律跳过，不会误关。
set -u

if [ "${ATS_KEEP_WINDOW:-0}" = "1" ]; then exit 0; fi
if [ "${TERM_PROGRAM:-}" != "Apple_Terminal" ]; then exit 0; fi
if ! command -v osascript >/dev/null 2>&1; then exit 0; fi

mytty="$(tty 2>/dev/null || true)"
if [ -z "$mytty" ]; then exit 0; fi

sleep "${1:-1.5}"

osascript >/dev/null 2>&1 <<EOF || exit 0
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "$mytty" then
        close t
        return
      end if
    end repeat
  end repeat
end tell
EOF
exit 0
