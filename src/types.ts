// 数据模型定义。所有用量单位都是 token。
// realCost 单位为元（¥ 口径），来自会话数据里 provider 记录的 usage.cost.total；
// 部分提供商不记录该字段（为 0），前端按单价配置估算兜底，UI 上区分「实 / 估」。

export interface Usage {
  input: number;       // 未命中缓存的输入
  output: number;      // 输出（含推理）
  cacheRead: number;   // 缓存命中（prompt cache read）
  cacheWrite: number;  // 缓存写入
  reasoning: number;   // 推理 token（通常已包含在输出内）
  totalTokens: number; // 四项之和（约等于上下文体量）
  realCost: number;    // 数据内记录的真实费用合计（¥）
}

// 数据来源。pi = ~/.pi/agent/sessions 的 jsonl；opencode = opencode.db (SQLite)。
// 接入新数据源（codex / claude code / ...）时在此扩展联合类型，并实现一个 SourceAdapter。
export type SourceKind = 'pi' | 'opencode' | (string & {});

import type { ScanStore } from './store.ts';

// 单个数据源一轮扫描的产出。sessions 必须是「本源全部会话」，
// 包括源数据已删除、仅存于本地库的归档会话 —— 归档是本项目的核心承诺。
export interface SourceScanOutcome {
  sessions: SessionAgg[];
  scannedUnits: number; // 本轮真正全量重解析的扫描单位数（增量命中的不算）
  skippedLines: number; // 坏行 / 跳过统计
  stat: SourceStat;
}

// 数据源适配器。scan 的职责：
//  1. 读取源数据（增量优先，用 store 里的游标判断从哪继续）
//  2. 把有变化的会话聚合 upsert 进 store（永不 delete，除非口径作废）
//  3. 返回本源全部会话（store 里的 = 当前源里的 + 已归档的）
// 接入新数据源 = 写一个实现 + 在 scan.ts 的 ADAPTERS 里注册一行。
export interface SourceAdapter {
  kind: SourceKind;
  scan(store: ScanStore, aliases: Record<string, string>): Promise<SourceScanOutcome>;
}

// 单个会话的聚合结果。所有维度都带 dayUsage / modelUsage，
// 让前端可以在任意时间窗口内严格重算。
export interface SessionAgg extends Usage {
  id: string;
  source: SourceKind;                       // 数据来源
  cwd: string;                              // 工作区（pi: session 事件 cwd / opencode: session.directory）
  name: string;                             // 会话名（首条 user 消息摘要）
  startTs: string | null;
  endTs: string | null;
  messages: number;                         // assistant 消息数
  archived?: boolean;                       // 源数据已删除，此聚合仅存于本地库（归档）
  dayUsage: Record<string, Usage>;          // 按天（运行环境本地时区）拆分
  modelUsage: Record<string, Usage>;        // 按归一化模型名拆分（全会话）
  modelDayUsage: Record<string, Record<string, Usage>>; // 模型 × 天，用于窗口内精确算花费
  providerUsage: Record<string, Usage>;     // 按提供商拆分（全会话）
  providerModelUsage: Record<string, Record<string, Usage>>; // 提供商 → 原始模型名拆分
}

// 每百万 token 单价（以 currency 币种计，固定 ¥）
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// prices.json 的结构（含扩展配置），也是 /api/prices 的载荷
export interface PriceConfig {
  currency: string;                      // 单价币种符号，固定 '¥'
  rates: Record<string, number>;         // 显示用汇率：1 该币种 = N ¥（如 $: 7.2）
  prices: Record<string, ModelPrice>;    // key 为归一化后的模型名
  modelAliases: Record<string, string>;  // 模型名映射表：原始名 → 归一名
}

// 单个数据源的扫描概况（给前端 meta 行与来源筛选用）
export interface SourceStat {
  location: string;   // pi: 会话目录 / opencode: 数据库路径
  enabled: boolean;   // 数据源是否存在/可读
  sessions: number;   // 会话数
  error?: string;     // 打开或读取失败的原因
}

// 磁盘扫描结果（不含配置）
export interface ScanResult {
  generatedAt: string;
  sources: Record<SourceKind, SourceStat>;
  sessions: SessionAgg[];
  scannedFiles: number;                  // 本轮全量重解析的扫描单位数（增量命中的不算）
  skippedLines: number;                  // 解析失败的行数（坏行统计，各数据源合计）
  /** 数据版本号 = 落库版本 + 价格配置指纹。前端轮询带上它，没变就只回空载荷 */
  revision: string;
}

// /api/data 返回体 = 扫描结果 + 价格配置
export type ApiData = ScanResult & PriceConfig;
