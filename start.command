#!/bin/bash
# 用户用：启动 agent-token-stats 看板并打开浏览器（macOS 双击 / 终端运行皆可）
# agent 与脚本请改用 ./manager.sh start —— 它不会打开浏览器（manager.command 为兼容链接）。
exec "$(cd "$(dirname "$0")" && pwd)/manager.sh" start --open "$@"
