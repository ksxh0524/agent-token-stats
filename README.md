# pi-token-stats

本地看板：统计 [pi coding agent](https://github.com/badlogic/pi-mono) 的 token 消耗，按 工作区 / 会话 / 天 / 模型 / 提供商 维度展示。

零运行时依赖（仅 devDependencies：typescript / prettier），前端零构建（原生 ES modules）。

## 启动

```bash
./start.command        # 双击亦可；启动后自动打开 http://localhost:32022
./stop.command         # 停止
```

等价命令：

```bash
npm start              # PORT 默认 32022，可用环境变量覆盖
npm run dev            # watch 模式
npm run typecheck      # tsc --noEmit
npm test               # node:test 单元测试
```

要求 Node >= 22.6（`--experimental-strip-types`）。会话目录默认 `~/.pi/agent/sessions`，可用 `PI_SESSIONS_DIR` 覆盖。

## 界面

- **总览**：汇总卡片、工作区表（点击行筛选）、按模型/按提供商条形图
- **模型明细**：每个归一化模型的 输入/输出/缓存命中/缓存写入/推理/总 token/占比/实花/估算/合计，可排序（含合计行）
- **会话明细**：单会话粒度明细
- **设置**（默认收起）：价格配置、显示汇率、模型别名映射、数据说明

### 时间窗口

默认显示**近 30 天**（Asia/Shanghai 口径），可切 7/30/90 天或自定义区间。
窗口对所有维度严格生效：窗口内没有用量的模型 / 工作区 / 会话不会出现。

### 花费口径

- 单价以 **¥** 存储（每百万 token）；顶栏币种切换只影响**显示**，按设置页汇率换算
- 「实」= 会话数据中 provider 记录的真实费用（`usage.cost.total`）
- 「估」= 无真实费用时按配置单价推算（全部按量口径）
- 想看某一天的消耗，把时间范围选到那一天即可（按天维度已并入时间窗口筛选）
- 花费在「模型 × 天」粒度取值：该格有真实费用用真实值，否则用估算；三个视图数字保证一致

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/data` | 扫描结果 + 价格配置（2s 内合并重复请求） |
| GET/POST | `/api/prices` | 读取 / 保存价格配置（原子写盘，POST 限本机来源） |
| GET | `/health` | 健康检查 |

## 目录结构

```
src/
  scan.ts      # jsonl 解析 + 增量缓存 + 模型名归一 + 四维度聚合
  server.ts    # HTTP 服务 + 配置管理 + API 加固
  types.ts     # 数据模型
public/
  index.html   # 骨架
  style.css
  js/          # app/state/api/aggregate/render/calendar/format/defaults
test/          # node:test 单测 + fixtures
prices.json    # 运行时配置（已 gitignore）
```
