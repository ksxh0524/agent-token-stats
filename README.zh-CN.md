# agent-token-stats

> 本地看板：统计 coding agent 的 token 消耗，支持 **pi**（[badlogic/pi-mono](https://github.com/badlogic/pi-mono)）与 **opencode** 两种数据源，按 **数据源 / 工作区 / 会话 / 天 / 模型 / 提供商** 维度展示。

[English](./README.md) | **中文**

[![Node >=22.6](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![前端零构建](https://img.shields.io/badge/frontend-zero--build-orange)](#目录结构)

零运行时依赖（仅 devDependencies：`typescript` / `prettier`；opencode 走内置 `node:sqlite`），前端零构建（原生 ES modules）。支持数百会话秒级扫描与磁盘缓存持久化。

---

## 功能特性

- **多数据源、严格隔离** — 内置 `pi`（`~/.pi/agent/sessions/*.jsonl`）与 `opencode`（`~/.local/share/opencode/opencode.db`），前端 Tab 按 `/api/data` 的数据源 key 动态生成——接入新数据源（codex / claude code / …）只需后端加一个适配器，前端零改动。
- **SQLite 持久化 + 归档承诺** — 聚合结果落盘 `.cache/store.db`（`PI_SCAN_DB` 可覆盖）：源会话被删后历史统计保留并标「档」；pi 的 resume/分支多文件同 id 自动合并，不重复计数。
- **增量扫描** — pi 按字节偏移只解析新增内容（65MB 会话追加一行也只读几十字节），opencode 按库签名增量重建；解析器上下文（模型归属/会话名）随游标一并持久化。
- **多维聚合** — 工作区总消耗、按模型、模型明细（条形图 + 可排序表格）、按提供商、会话明细。
- **时间窗口** — 默认 **近 3 天**（`Asia/Shanghai` 口径），可切 7/30/90 天或自定义区间；窗口对所有维度严格生效。
- **花费口径** — 单价以 **¥ / 百万 token** 存储，顶栏币种切换仅影响显示（按汇率换算）。`实` = provider 记录的 `usage.cost.total`，`估` = 无实费时按单价推算；花费在 **模型 × 天** 粒度取值，保证三处视图一致。
- **模型归一** — 去组织前缀（`deepseek-ai/`、`nvidia/`）、小写、冒号转连字符，支持可编辑的别名映射表。
- **价格同步** — 设置面板一键拉取：pi 用户配置（`~/.pi/agent/models.json` 的 cost，`PI_MODELS_FILE` 可覆盖）优先，models.dev 官方价目录兜底，按汇率折 ¥ 只填「全 0 未配置」的模型，手填值永不覆盖。
- **增量轮询** — 看板每 30s 带数据版本号轮询：数据没变化服务端只回约 100 字节（实测全量 1.1MB → 短路 98 字节），跳过大载荷解析与整页重渲染；会话明细表分批渲染（先 150 行，滚动到底自动追加）。

## 环境要求

- Node.js **>= 22.6**（使用 `--experimental-strip-types` 直接运行 TypeScript，无需构建）。

## 快速开始

### 面向用户（会打开浏览器）

```bash
./start.command        # 双击亦可；启动后自动打开 http://localhost:32022
./stop.command
```

### 面向 agent / 脚本（不开浏览器）

```bash
./manager.sh start            # 脱离进程组启动，等 /health 通过才返回
./manager.sh stop             # 三层兜底：PID 文件 → 进程匹配 → 端口占用
./manager.sh restart          # 改完后端代码用这个
./manager.sh status           # 退出码 0=运行中 3=未运行 4=进程在但 /health 不通
./manager.sh status --json    # 一行 JSON，便于脚本解析
```

`start.command` / `stop.command` 只是 `manager.sh` 的薄封装（`manager.command` 为兼容符号链接，多了 `--open`）。`manager.sh` 在 macOS 上以 perl `fork+setsid` 兜底，调用方退出后服务仍在。

### npm 等价命令

```bash
npm start              # PORT 默认 32022，可用环境变量覆盖
npm run dev            # watch 模式
npm run typecheck      # tsc --noEmit
npm test               # node:test 单元测试
npm run fmt            # prettier 格式化
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `32022` | HTTP 监听端口 |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | pi 会话目录 |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | opencode SQLite 路径（只读打开） |
| `PRICES_FILE` | `./prices.json` | 价格/别名配置文件 |
| `PI_SCAN_DB` | `./.cache/store.db` | 自有聚合库（SQLite，含归档与扫描游标） |

> `prices.json` 与 `.cache/` 已 gitignore。改 pi 解析口径时 `src/sources/pi.ts` 的 `PARSER_VERSION` +1、改 opencode 口径时 `src/sources/opencode.ts` 的 `OPENCODE_PARSER_VERSION` +1，库里旧口径的聚合会整体作废重算（见 `AGENTS.md`）。

## 界面导览

单页布局，从上往下滚动浏览；顶部 **pi / opencode** Tab 切换数据源。

- **总览卡片** — 汇总指标、时间范围、工作区筛选、会话搜索
- **工作区总消耗** — 点击行筛选
- **按模型 / 模型明细 / 按提供商** — 条形图 + 可排序表格（含合计行）
- **会话明细** — 固定高度内部滚动
- **设置**（右上角齿轮，默认收起）— 价格配置、显示汇率、模型别名映射、数据说明
- 数字用中文单位显示（万 / 亿，如 `1.4亿`），悬停查看完整数字；花费跟随顶栏币种换算。

## 时间窗口与花费口径

- 默认 **近 3 天**（`Asia/Shanghai`），可切 7/30/90/自定义；窗口对所有维度一致过滤，窗口内无用量的模型/工作区/会话不会出现。
- 单价以 **¥** 存储（每百万 token）；顶栏币种切换只影响**显示**，按设置页汇率换算。
- `实` = 会话数据中 provider 记录的真实费用（`usage.cost.total`）；`估` = 无真实费用时按配置单价推算（均为按量口径）。
- 想看某一天的消耗，把时间范围选到那一天即可（按天维度已并入时间窗口筛选）。
- 花费在 **模型 × 天** 粒度取值：该格有真实费用用真实值，否则用估算；三个视图数字保证一致。

## 用量归集口径（pi）

一条事件可能承载多处用量，全部计入所在会话：

| 位置 | 场景 | 模型归属 |
|------|------|----------|
| `message.usage` + `role=assistant` | 主会话对话 | `message.model` |
| `message.details.results[].usage` | **subagent**：每个子 agent 一条，各带自己的模型 | 该 result 的 `model` |
| `message.usage` + `role=toolResult` | 工具内部发起的 LLM 调用（如 `formal_review`） | `details.model` 兜底 `message.model` |
| 顶层 `usage`（`compaction` 等） | 上下文压缩 | 事件不带模型，归因到会话内最近一次 assistant 所用模型 |

- 全零用量（subagent 失败调用留的空壳）跳过，不污染模型维度
- subagent 的 `cost` 是裸数字，assistant 的 `cost` 是 `{ total }`，两者都收
- `totalTokens` 缺失时回退为 `input+output+cacheRead+cacheWrite` 四项之和
- 解析口径变更时 `PARSER_VERSION` +1，库内旧口径聚合整体作废重算

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/data` | 扫描结果 + 价格配置（2s 内合并重复请求）；带 `?rev=<上次 revision>` 时版本未变只回 `{unchanged:true}` |
| `GET`/`POST` | `/api/prices` | 读取 / 保存价格配置（原子写盘，POST 限本机 `Origin`/`Host`） |
| `GET` | `/health` | 健康检查 |

## 配置说明

均在 `prices.json` 中，通过 `GET/POST /api/prices` 或设置面板编辑：

- **`prices`** — `模型 → { input, output, cacheRead, cacheWrite }`（¥/M tokens）。面板中可一键填入官方默认价（见 `public/js/defaults.js:5`）。
- **`rates`** — `币种 → 汇率`，`1 该币种 = N ¥`（如 `$: 7.2`），仅用于显示换算。
- **`modelAliases`** — `原始名 → 归一名`，面板中每行 `原始名 = 归一名`。内置规则已自动去组织前缀（末段为 `free`/`latest` 等泛词时保留全名避免碰撞）并小写、冒号转连字符；此处映射优先，`-free` 等后缀默认保留以区分计价。
- **`currency`** — 单价币种符号，固定 `¥`。

## 目录结构

```
src/
  scan.ts          # 扫描协调器：适配器注册表（ADAPTERS）+ 多源汇总，不认识具体数据源
  store.ts         # 自有 SQLite：units（游标+聚合+归档）+ meta（版本号），只 upsert 永不 delete
  sources/
    pi.ts          # pi jsonl 适配器：字节偏移增量 + 解析器上下文持久化
    opencode.ts    # opencode SQLite 适配器：库签名增量
  server.ts        # HTTP 服务 + 静态托管 + /api/* 加固 + rev 短路
  types.ts         # 数据模型（SourceAdapter 接口 / SessionAgg / ScanResult）
public/
  index.html       # 单页骨架（数据源 tab 动态生成）
  style.css
  js/              # app/state/api/aggregate/render/calendar/format/defaults
test/              # node:test 单测 + fixtures（含归档/增量轮询用例）
prices.json        # 运行时配置（已 gitignore）
.cache/store.db    # 自有聚合库（自动生成，已 gitignore，PI_SCAN_DB 可覆盖）
manager.sh（+ manager.command 兼容链接）/ start.command / stop.command
```

## 性能

- **首次建库**：行级预筛跳过纯文本行的 `JSON.parse` + 8 并发解析，870 个会话文件一次性入库约 2 分钟（只发生一次）。
- **日常重启 / 轮询**：游标（字节偏移 + 解析上下文）跨进程持久化，增量扫描约 0.6s；数据没变化时 `/api/data` 只回约 100 字节，前端零重渲染。
- **改解析口径**：`PARSER_VERSION`/`OPENCODE_PARSER_VERSION` +1 触发一次全量重算入库，之后恢复增量。

## 开发

```bash
npm run typecheck && npm test
./manager.sh restart
```

- 扫描逻辑改动后用真实数据验证 `Σ(模型维度) == 总用量`，缺口必须为 `0`（见 `AGENTS.md`）。
- 服务进程一律用 `./manager.sh <start|stop|restart|status>`（`manager.command` 为兼容符号链接）；禁止用 `start.command`（会弹浏览器）。

## 许可证

暂未添加 `LICENSE` 文件，默认保留所有权利。如需开源请补充 `LICENSE`（如 MIT / Apache-2.0）。
