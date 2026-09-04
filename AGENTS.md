# AGENTS.md

服务进程一律用 `./manager.sh <start|stop|restart|status>`；禁止用 `start.command`（会弹浏览器）。
`./manager.sh status` 退出码：0=运行中 3=未运行 4=进程在但 health 不通。
改完 `src/*.ts` 后跑 `npm run typecheck && npm test`，再 `./manager.sh restart`。
改 pi 解析口径时 `src/sources/pi.ts` 的 `PARSER_VERSION` +1；改 opencode 的 SQL/字段解释时 `src/sources/opencode.ts` 的 `OPENCODE_PARSER_VERSION` +1——否则库里旧口径的聚合不会作废重算。
扫描逻辑改动后用真实数据验证「模型维度合计 == 总用量」，缺口必须为 0。
架构：`src/scan.ts` 只做适配器注册与汇总；各源适配器在 `src/sources/`；聚合与游标持久化在 `src/store.ts`（SQLite，路径 `PI_SCAN_DB` 可覆盖，默认 `.cache/store.db`）。接入新数据源 = 新增 `src/sources/<name>.ts` + ADAPTERS 注册一行，前端零改动。
store 硬规则：units 行只 upsert、永不 delete——源文件删了就是归档（archived 列）；聚合增量基准按 unit（文件）不按会话 id（pi resume/分支多文件同 id，按 id 会翻倍）；任何影响 /api/data 输出的落库变化都要让 `data_revision` +1（putUnits/setArchived 已内置，别绕开）。
`/api/data?rev=<revision>` 版本没变只回 `{unchanged:true}`：改输出语义时先想清楚 revision 是否会被 bump，否则轮询客户端会错过变化。
shell 里禁止写 `[ 条件 ] && 命令`：set -e 下条件不成立会让脚本静默退出，一律用 if 块。
start.command / stop.command 跑完自动关闭当前 Terminal 标签页（ATS_KEEP_WINDOW=1 保留），关窗逻辑在 `.close-window.sh`。
