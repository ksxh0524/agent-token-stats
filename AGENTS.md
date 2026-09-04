# AGENTS.md

服务进程一律用 `./manager.sh <start|stop|restart|status>`（`manager.command` 为兼容符号链接）；禁止用 `start.command`（会弹浏览器）。
`./manager.sh status` 退出码：0=运行中 3=未运行 4=进程在但 health 不通。
改完 `src/*.ts` 后跑 `npm run typecheck && npm test`，再 `./manager.sh restart`。
改 pi 解析口径时 `PARSER_VERSION` +1，否则磁盘缓存不会失效。
start.command / stop.command 跑完自动关闭当前 Terminal 标签页（ATS_KEEP_WINDOW=1 保留），关窗逻辑在 `.close-window.sh`。
shell 里禁止写 `[ 条件 ] && 命令`：set -e 下条件不成立会让脚本静默退出，一律用 if 块。
扫描逻辑改动后用真实数据验证「模型维度合计 == 总用量」，缺口必须为 0。
