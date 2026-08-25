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

// 单个会话的聚合结果。所有维度都带 dayUsage / modelUsage，
// 让前端可以在任意时间窗口内严格重算。
export interface SessionAgg extends Usage {
  id: string;
  cwd: string;                              // 工作区（session 事件的 cwd）
  name: string;                             // 会话名（首条 user 消息摘要）
  startTs: string | null;
  endTs: string | null;
  messages: number;                         // assistant 消息数
  dayUsage: Record<string, Usage>;          // 按天（Asia/Shanghai）拆分
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

// 磁盘扫描结果（不含配置）
export interface ScanResult {
  generatedAt: string;
  sessionsDir: string;
  sessions: SessionAgg[];
  scannedFiles: number;
  skippedLines: number;                  // 解析失败的行数（坏行统计）
}

// /api/data 返回体 = 扫描结果 + 价格配置
export type ApiData = ScanResult & PriceConfig;
