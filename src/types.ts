// 数据模型定义。所有用量单位都是 token（pi 本地的 cost 字段恒为 0，金额需另算）。

export interface Usage {
  input: number;       // 未命中缓存的输入
  output: number;      // 输出
  cacheRead: number;   // 缓存命中（prompt cache read）
  cacheWrite: number;  // 缓存写入
  totalTokens: number; // 上面四项之和（约等于上下文体量，非实际计费量）
}

export interface Totals extends Usage {
  messages: number; // assistant 消息数
}

// 单个会话的聚合结果。dayUsage / modelUsage / providerUsage 让前端可以按工作区自由筛选再聚合。
export interface SessionAgg extends Usage {
  id: string;
  cwd: string;                              // 工作区（来自 session 事件的 cwd，即真实项目路径）
  name: string;                             // 会话名（首条 user 消息摘要）
  startTs: string | null;
  endTs: string | null;
  messages: number;
  dayUsage: Record<string, Usage>;         // 按天（Asia/Shanghai）拆分
  modelUsage: Record<string, Usage>;       // 按模型拆分
  providerUsage: Record<string, Usage>;    // 按提供商拆分（顶层汇总，用于 token 显示）
  providerModelUsage: Record<string, Record<string, Usage>>; // 按提供商→模型拆分（用于精确算花费）
}

export interface ScanResult {
  generatedAt: string;   // 扫描完成时间（ISO）
  sessionsDir: string;   // 实际扫描的会话目录
  sessions: SessionAgg[];
}
