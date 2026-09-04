#!/bin/bash
# 用户用：启动 agent-token-stats 看板并打开浏览器（macOS 双击 / 终端运行皆可）
# 启动成功后停留 1.5s 展示结果，然后自动关闭这个终端窗口（失败时保留窗口看报错）。
#   ATS_KEEP_WINDOW=1 ./start.command   保留窗口不自动关
# agent 与脚本请改用 ./manager.sh start —— 它不会打开浏览器。
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/manager.sh" start --open "$@"
rc=$?

if [ "$rc" -eq 0 ]; then
  "$DIR/.close-window.sh" 1.5
fi
exit $rc
