# agent-token-stats

> 本地看板：统计 coding agent 的 token 消耗，支持 **pi**（[badlogic/pi-mono](https://github.com/badlogic/pi-mono)）与 **opencode** 两种数据源，按 **数据源 / 工作区 / 会话 / 天 / 模型 / 提供商** 维度展示。

[English](./README.md) | **中文**

[![Node >=22.6](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![前端零构建](https://img.shields.io/badge/frontend-zero--build-orange)](#目录结构)

零运行时依赖（仅 devDependencies：`typescript` / `prettier`；opencode 走内置 `node:sqlite`），前端零构建（原生 ES modules）。支持数百会话秒级扫描与磁盘缓存持久化。

---

## 功能特性

- **双数据源、严格隔离** — `pi`（`~/.pi/agent/sessions/*.jsonl`）与 `opencode`（`~/.local/share/opencode/opencode.db`）分别扫描，前端以 `pi / opencode` Tab 切换，数据绝不混算。
- **多维聚合** — 工作区总消耗、按模型、模型明细（条形图 + 可排序表格）、按提供商、会话明细。
- **时间窗口** — 默认 **近 3 天**（`Asia/Shanghai` 口径），可切 7/30/90 天或自定义区间；窗口对所有维度严格生效。
- **花费口径** — 单价以 **¥ / 百万 token** 存储，顶栏币种切换仅影响显示（按汇率换算）。`实` = provider 记录的 `usage.cost.total`，`估` = 无实费时按单价推算；花费在 **模型 × 天** 粒度取值，保证三处视图一致。
- **模型归一** — 去组织前缀（`deepseek-ai/`、`nvidia/`）、小写、冒号转连字符，支持可编辑的别名映射表。
- **扫描性能** — 行级预筛跳过纯文本行的 `JSON.parse` + 8 并发解析 + `mtime:size + 别名哈希` 磁盘缓存；运行中内存增量 + `/api/data` 2s 请求合并。

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
| `PI_SCAN_CACHE` | `./.cache/pi-scan-cache.json` | pi 磁盘缓存路径 |

> `prices.json` 与 `.cache/` 已 gitignore。解析口径变更时需 `PARSER_VERSION +1`（见 `src/scan.ts:36` 与 `AGENTS.md`），否则磁盘缓存不会失效。

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
- 解析口径变更时 `PARSER_VERSION` +1，磁盘缓存整体失效重算

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/data` | 扫描结果 + 价格配置（2s 内合并重复请求） |
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
  scan.ts      # pi jsonl 解析（预筛/并发/磁盘缓存）+ 模型名归一 + 多源合并
  opencode.ts  # opencode SQLite (node:sqlite 只读) 解析，同一 SessionAgg 结构
  util.ts      # 共享纯工具（用量累加、按天、模型名归一、哈希）
  server.ts    # HTTP 服务 + 静态托管 + API 加固
  types.ts     # 数据模型
public/
  index.html   # 单页骨架（pi / opencode tab）
  style.css
  js/          # app/state/api/aggregate/render/calendar/format/defaults
test/          # node:test 单测 + fixtures
prices.json    # 运行时配置（已 gitignore）
.cache/        # 扫描结果磁盘缓存（自动生成，已 gitignore，PI_SCAN_CACHE 可覆盖）
manager.sh（+ manager.command 兼容链接）/ start.command / stop.command
```

## 性能

- **首次冷扫描**：行级预筛跳过纯文本行的 `JSON.parse` + 8 并发文件解析，I/O 与解析重叠。
- **重启后**：磁盘缓存按 `mtime:size + 别名哈希` 复用聚合结果，实测 532 个会话 ~5.4s → ~0.2s。
- **运行中**：内存缓存增量刷新，`/api/data` 2s 内合并重复请求并让出事件循环保持响应。

## 开发

```bash
npm run typecheck && npm test
./manager.sh restart
```

- 扫描逻辑改动后用真实数据验证 `Σ(模型维度) == 总用量`，缺口必须为 `0`（见 `AGENTS.md`）。
- 服务进程一律用 `./manager.sh <start|stop|restart|status>`（`manager.command` 为兼容符号链接）；禁止用 `start.command`（会弹浏览器）。

## 许可证

暂未添加 `LICENSE` 文件，默认保留所有权利。如需开源请补充 `LICENSE`（如 MIT / Apache-2.0）。
