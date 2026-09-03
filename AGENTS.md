# AGENTS.md

服务进程一律用 `./manager.sh <start|stop|restart|status>`（`manager.command` 为兼容符号链接）；禁止用 `start.command`（会弹浏览器）。
`./manager.sh status` 退出码：0=运行中 3=未运行 4=进程在但 health 不通。
改完 `src/*.ts` 后跑 `npm run typecheck && npm test`，再 `./manager.sh restart`。
改 pi 解析口径时 `PARSER_VERSION` +1，否则磁盘缓存不会失效。
扫描逻辑改动后用真实数据验证「模型维度合计 == 总用量」，缺口必须为 0。
