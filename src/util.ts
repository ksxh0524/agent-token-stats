// scan / opencode 两个数据源共用的纯工具函数。
import type { Usage } from './types.ts';

/** Usage → Usage 的累加（与 addUsage 不同：入参已是规整的 Usage，realCost 直接取字段）。
 *  增量扫描把一段新聚合并进累计聚合时必须用它；错用 addUsage 会把 realCost 全部丢成 0。 */
export function mergeUsage(acc: Usage, u: Usage): void {
  acc.input += u.input;
  acc.output += u.output;
  acc.cacheRead += u.cacheRead;
  acc.cacheWrite += u.cacheWrite;
  acc.reasoning += u.reasoning;
  acc.totalTokens += u.totalTokens;
  acc.realCost += u.realCost;
}

// cost 有两种形状：assistant 消息里是 { total }，subagent 结果里是裸数字
export type RawCost = { total?: number } | number | null;
export type RawUsage = Partial<Omit<Usage, 'realCost'>> & { cost?: RawCost };

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, realCost: 0 };
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function str(v: unknown): string {
  return typeof v === 'string' && v ? v : '';
}

export function addUsage(acc: Usage, u: RawUsage | null | undefined): void {
  if (!u) return;
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  acc.input += input;
  acc.output += output;
  acc.cacheRead += cacheRead;
  acc.cacheWrite += cacheWrite;
  acc.reasoning += num(u.reasoning);
  // totalTokens 缺失或为 0 时回退为四项之和
  const sum4 = input + output + cacheRead + cacheWrite;
  const tt = num(u.totalTokens);
  acc.totalTokens += tt > 0 ? tt : sum4;
  acc.realCost += typeof u.cost === 'number' ? num(u.cost) : num(u.cost?.total);
}

/** 全零用量（subagent 失败调用会留一条空 usage）没有统计意义，跳过避免污染模型维度 */
export function isEmptyUsage(u: RawUsage | null | undefined): boolean {
  if (!u) return true;
  return !(
    num(u.input) ||
    num(u.output) ||
    num(u.cacheRead) ||
    num(u.cacheWrite) ||
    num(u.reasoning) ||
    num(u.totalTokens)
  );
}

// ISO 时间 → 系统本地时区的 YYYY-MM-DD（读电脑时区设置，不再写死 Asia/Shanghai）
export function localDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA'); // 无 timeZone 参数 = 本地时区, YYYY-MM-DD
}

// 稳定短哈希（FNV-1a 32bit）：用于把别名配置并入缓存键
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function aliasHash(aliases: Record<string, string>): string {
  const keys = Object.keys(aliases).sort();
  if (!keys.length) return '0';
  return fnv1a(keys.map((k) => `${k}=${aliases[k]}`).join('\n'));
}

// 归一化中视为「泛词」的末段：这类名字不承载模型信息，保留全名避免歧义碰撞
const GENERIC_TAIL = new Set(['free', 'latest', 'default', 'chat', 'pro']);

// 模型名归一：映射表优先；否则去 org/ 前缀、冒号转连字符、小写。
// '-free' 等后缀保留 —— 免费/收费是不同口径，必须分开计价。
export function normalizeModelName(raw: string, aliases: Record<string, string> = {}): string {
  let name = (raw || '').trim();
  if (!name) return 'unknown';
  const mapped = aliases[name];
  if (mapped) return mapped;
  const i = name.indexOf('/');
  if (i > 0 && i < name.length - 1) {
    const tail = name.slice(i + 1).toLowerCase();
    if (!GENERIC_TAIL.has(tail)) name = name.slice(i + 1);
  }
  name = name.replace(/:/g, '-').trim().toLowerCase();
  return name || 'unknown';
}
