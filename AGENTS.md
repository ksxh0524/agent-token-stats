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

价格同步（`src/prices-sync.ts`）：**只给本地实际用到的模型拉价**——范围由 `localModelScope()` 决定 = `prices.json` 已有的 key ∪ 所有会话（pi / opencode）出现过的模型名，通过 `syncPrices(cfg, save, { only })` 传入。绝不要改成把 models.dev 整个目录灌进本地配置（那是七千多个模型，本地只用几十个）。
数据源 https://models.dev/api.json（模型价字段叫 `cost`，不是 `pricing`；缓存字段 `cache_read` / `cache_write`——读错字段会静默拿到 0 个候选，同步看起来"跑了"但什么都没填）。GitHub 仓库 `anomalyco/models.dev` 只用来补站点构建延迟：拉近期变更的 provider TOML，api.json 本身就是这个仓库的构建产物。
时机：服务启动后 10s + 每 12h 自动跑；`PRICES_SYNC=off`、`PRICES_SYNC_INTERVAL_MS`、`PRICES_SYNC_DELAY_MS` 可调；`POST /api/prices/sync` 手动触发（`?dryRun=1` 只算不落盘）。
合并规则：缺失或全 0 的 key 直接填；已有非 0 价只有 `priceSources` 标成 `models.dev` / `github` 的才允许被纠正，`manual` / `pi` 以及**没有来源记录**的历史值一律不覆盖。改这条前先想清楚会不会吃掉用户手填的价。
候选排序按「模型归属原厂 → 其他原厂 → 第三方 → 聚合站」四级，别用模型 id 的 org 前缀当原厂判据（中转站会用自己的名字当前缀，如 `cline-pass/glm-5.3`）。
价格表 UI 只渲染当前行，`readPrices()` 必须以 `state.data.prices` 为基准增量覆盖——否则表格状态不完整时保存会把没渲染出来的模型整片删掉。
「按服务商」视图的服务商行可收起（点合计行切换 / 「全部收起·展开」批量），收起集合存 `state.collapsedProviders` → prefs。模型行始终渲染、只用 `is-hidden` 控显隐，切换是纯 DOM 不改 class 之外的任何东西，**不要为此重跑聚合**。
前端坑：给带 `display` 的 class（如 `.view-switch`）加 `hidden` 属性是无效的——类选择器的 `display` 优先级高于 UA 的 `[hidden]{display:none}`，必须显式补 `xxx[hidden]{display:none}`。
配置**一律实时保存，不放任何「保存」按钮**：价格输入框和别名 textarea 都走 `change`（失焦/回车）→ `pushConfig()` → `POST /api/prices`。用 `change` 而不是 `input` 是刻意的——别名一变服务端要按新 `aliasHash` 全量重扫，逐键触发会把重扫打成一串。别给它们加回保存按钮，也别改成 `input` 监听。别名 textarea 下方 `#aliasNote` 显示「保存中…/已保存」。
价格只有一个入口：同步（pi 配置优先 → models.dev）＋ 界面手填。同样的理由，别名映射的 `#saveAlias`「保存映射」按钮 2026-09-12 也删了（`public/index.html`）；`public/js/app.js` 里那次 `pushConfig()` 的 click 绑定一并移除。
`public/js/defaults.js` 里那份硬编码的 `DEFAULTS`「内置默认价」和对应按钮 2026-09-12 已删——它是覆盖式的死值，会冲掉手填价；`defaults.js` 现在只剩 `zeroPrice()`。
同步写入前 `scale()` 会把「美元 × 汇率」round 到 6 位小数（否则落盘和界面出现 `31.680000000000003`），`samePrice()` 用严格相等判断，好让带浮点尾巴的旧值被重写。
变体名路由（`buildModelRoutes` + `util.ts` 的 `routeModelName`）：provider 会给同一模型挂后缀（`deepseek-v4-pro-0731` / `-preview` / `-thinking`），这类名字独立计价会裂成多行且全都无价。同步时按后缀正则一层层往回剥、命中已有价格表里的基名就登记进 `modelAliases`，扫描时直接归一到基名。**后缀白名单不含 `-free` / `-pro` / `-flash` / `-max` / `-mini`**——免费与收费、不同档位是不同口径，合并会算出错的价。只路由「没有价格条目」的名字，已有 key（含 models.dev 给的合法 0 价）一律不动。
别名一变 `aliasHash` 就变 → 下一次 `/api/data` 全量重解析，`data_revision` 跟着走，前端无需额外通知。
汇率：界面只选显示币种，比例由服务端每天从免费源（`src/rates.ts`，`open.er-api.com`）拉一次写进配置；**`POST /api/prices` 忽略前端回传的 `rates`，一律用 `prev.rates`**。`RATES_SYNC=off` / `RATES_INTERVAL_MS` / `RATES_DELAY_MS` 可调。注意汇率一变，所有自动来源的价会按新汇率重算一遍（手填 / pi 的不动）。
`POST /api/prices` 带空 `prices` 会被拒（409），要清空必须显式 `?allowEmpty=1`——防页面数据没就绪时把整份配置抹了。

内存与启动（2026-09-27 实测，别回退）：
- 堆上限在 `manager.sh` 的 `NODE_FLAGS`（默认 `--max-old-space-size=192`）和 `package.json` 的 start/dev 里。V8 默认无上限，全量重扫 2GB 会话时 old space 虚涨到 150MB+、RSS 稳态 300MB+；加它后稳态 212MB。实测 96/128/192 三档差别不大，192 给活数据（≈50MB）留了 ~4 倍余量。要调就调 `NODE_FLAGS`，别在 JS 里做。
- pi 源**必须分块读**：整文件读入 = 1×Buffer + 1×UTF-16 字符串同时驻留，单个 65MB jsonl 让 RSS +187MB，8 路并发峰值 590–679MB —— 这就是「启动后 400 多 MB」的根因。见 `src/sources/pi.ts` 的 `scanLines`。
  ⚠️ 别把 `scanLines` 改成「每块 `Buffer.concat` 一个新 buffer」：macOS malloc arena 不把内存还给系统，实测 8000 次 256KB 分配把 RSS 顶到 1GB 且**稳定不降**（比整读还差一倍）。正确做法是缓冲区按 worker 复用、新字节读进帧头、只在换行处切割。
- 改 `scanLines` 必须跑 `test/pi-chunked.test.ts`：它锁死「跨块多字节字符不被解码成 U+FFFD」「末行半行不计入、补齐后只计一次」「增量结果逐字段 == 全量结果」三条。
- 扫描库 `units.ctx` 占 12.9MB、`agg` 2.8MB（pi 2315 行），每轮 scan 全量 `JSON.parse` 一次 → RSS +70MB，是 warm scan 的主要内存项。想再降先做「ctx 懒加载 + 按会话增量」，别动聚合口径。
- 验证扫描口径有没有改坏，**用 A/B 而不是自我检查**：建临时 store 跑一次冷启动全量重建，和线上增量库逐会话逐字段对比（记得传同一份 `modelAliases`，否则 modelUsage 键天然不同；opencode/pi 在跑时要排除近期仍在活动的会话）。冷启动全量 vs 增量库出现总量差，通常是「归档行」而不是 bug——新库没有源文件已删的归档。
- opencode 增量已改成**按会话水位**（2026-10-05）。两层：① db 签名（mtime:size + wal）没变 → 一个字节不碰源库；② 签名变了（opencode 在跑，每轮都变）→ 先走覆盖索引 `select distinct session_id from session_message where time_created > 水位` 找出动过的会话，只重建这些会话，其余复用库里已存的 agg。
  - 水位存 `units.ctx` 的 `{m: 该会话最后一条消息 time_created, f: session 元信息指纹}`；**db 签名存整库级 meta（`store.getSourceSig`/`setSourceSig`）**，不存 ctx——存 ctx 会让被删会话的归档行每轮都被 upsert，`data_revision` 永远停不下来。
  - **「跳过落库」判定（mtc 相等 + 指纹相等 → 不 upsert）是这套东西成立的关键**。安全窗口（水位回退 5 分钟，容忍时钟漂移）会让旧消息每轮被重扫一遍，全量重建下它们就是「每轮都写」；靠这个判定才能让 revision 在 opencode 运行时保持稳定。⚠️ 这个判定和「用全量查询还是逐会话查询」是两件独立的事，别再像 2026-10-05 那样用同一个标志位把两件事绑在一起。
  - 归档判据是「`session_v2` 里没有了」，**不是**「这轮没重建它」——增量的 built 只含动过的会话，拿 built 当判据会把所有没变化的会话误标成归档（真实库上中招过 1072/1079）。源里还在但库标了归档的会话必须重新落库把标记清回去。
  - 实测：26GB 库上 warm scan **2400ms → 160~210ms**，前端 `?rev=` 轮询**3.5MB → 100 字节 `{unchanged:true}`**。冷启动全量重建仍 ~11s。
  - 「按 `session.time_updated` 做增量」这条路**已证伪，别再走**：`time_updated` 不随消息追加可靠更新，实测 291/1079 个会话的 `time_updated` 比它最后一条消息还早。用 `time_created` 水位才安全。
  - 要改 opencode 源，先跑 `test/opencode.test.ts`（现在有 11 个用例，含「不空转」「不误标归档」「compaction 计入」几条回归）。
- ⚠️ **opencode 2.0.22（2026-09-29）把会话/消息迁到了 v2 表，老表当天就停止写入**。只读 `session` / `message` 的表现是「一切正常、实际漏掉迁移之后全部会话」——2026-10-05 就是这么发现的（看板显示 opencode 调用量 0，实际当天有 27 个会话）。现读 `session_v2` / `session_message`：
  - 判别：`sqlite_master` 里有没有 `session_v2`。有就读 v2，没有（老库）才回退老表——`hasV2Schema()`。
  - 字段差异：`role`（JSON 内）→ 独立 `type` 列；`$.modelID` / `$.providerID` → `$.model.id` / `$.model.providerID`。**variant 是 `$.model.variant` 的独立字段、不拼进 id**，所以 modelUsage 的键跨迁移期不变。
  - ⚠️ **v2 的过滤条件必须带 `'compaction'`**：压缩摘要本身是一次真实计费的 LLM 调用（实测 8 条 compaction 消息带 tokens：4896 input / 18787 output / 3.07M cacheRead）。只认 `'assistant'` 会把这块从总量里整块漏掉（老表里只有 assistant 带 token，所以这是迁移新引入的坑）。其余 type（user/system/synthetic/idle/agent-switched/model-switched）实测一律无 token。
  - `session_v2` 有冗余 `tokens_*` / `cost` 汇总列，但和 `session_message` 逐条求和对不上（250.1M vs 243.4M input），且拿不到按天/按模型拆分 → 一律以 `session_message` 为准。
  - v2 是老表的**严格超集**（老表 787 个 id 全部存在于 session_v2），所以不必合并两套。
  - 已知上游瑕疵：迁移给 20 个老会话各丢 1 条 assistant 消息（`session_v2` 自己的汇总列仍算着它），合计 -6.4M token；换来的是 191 个新会话 +3.07B token 和 2 个会话的尾部补全 +139M。别为了「对齐老汇总列」去补——v2 才是活表。
  - `OPENCODE_PARSER_VERSION` = 6。
- pi 的会话时间边界必须取 min/max，**不能「首个 timestamp 当 start、末个当 end」**：jsonl 事件时间戳不保证单调递增（实测有会话倒挂 9.5 秒），按首末赋值会产出 `startTs > endTs`。`PARSER_VERSION` = 5。
- pi 的 `totalTokens` 用源自报值（`addUsage` 里 `tt` 优先），所以它等于 `input+output+cacheRead+cacheWrite`（reasoning ⊆ output），不是五项和——这跟 opencode 相反，别拿一个口径去校验两个源。
- `opencode.db` 实际 **26GB**（2026-10-05 实测，`part` 表 250300 行）。改该源前先 `du -h ~/.local/share/opencode/opencode.db`；别再信文件里「3MB 级别」的旧注释（已改成 26GB）。
- 真实规模（复核基线，2026-10-05）：pi 1745 个 jsonl 会话（另有 935 个源文件已删的归档行，属设计承诺，不是 bug）；opencode 1079 个会话；合计 2824 个会话 / 载荷 3.5MB。全量重扫 ≈11s，warm scan ≈160~210ms。稳态 RSS **330~410MB 锯齿波动**（会话量比 2026-09-27 基线翻倍所致；实测 60 次连续请求后不单调增长，是 GC 锯齿不是泄漏）。
