#!/bin/bash
# 用户用：停止 agent-token-stats 看板（macOS 双击 / 终端运行皆可）
# agent 与脚本请改用 ./manager.sh stop（manager.command 为兼容链接）。
exec "$(cd "$(dirname "$0")" && pwd)/manager.sh" stop "$@"
