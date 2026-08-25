// 扫描 ~/.pi/agent/sessions 下所有 <目录>/<*.jsonl>，解析每条带 usage 的事件，聚合成 SessionAgg。
// 关键约定：
//  - 工作区 = session 事件的 cwd 字段（真实项目路径，比反解文件夹名靠谱）
//  - 会话名 = 首条 user 消息的文本摘要
//  - 天 = 按 Asia/Shanghai 时区把 timestamp 归到日期
//  - 模型名归一：去组织前缀（org/model）、小写、冒号转连字符；modelAliases 映射表优先
//  - 费用：usage.cost.total 为 provider 记录的真实费用，按 会话/天/模型/提供商 四维度累计
//
// 性能：
//  - 文件级增量缓存（mtime:size 签名），没变的文件直接复用上次结果
//  - 全异步 + 每 40 个文件让出事件循环，扫描期间服务仍可响应其它请求
import type { SessionAgg, ScanResult, Usage } from './types.ts';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

type RawCost = { total?: number } | null;
type RawUsage = Partial<Omit<Usage, 'realCost'>> & { cost?: RawCost };

const YIELD_EVERY = 40;
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, realCost: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function addUsage(acc: Usage, u: RawUsage | null | undefined): void {
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
  acc.realCost += num(u.cost?.total);
}

// usage 可能在顶层（compaction / branch_summary），也可能嵌在 message 里（assistant / tool）
function getUsage(e: Record<string, unknown>): RawUsage | null {
  const top = e.usage as RawUsage | undefined;
  if (top) return top;
  const msg = e.message as Record<string, unknown> | undefined;
  if (msg && msg.usage) return msg.usage as RawUsage;
  return null;
}

function shanghaiDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}

function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text') {
        const t = (b as Record<string, unknown>).text;
        if (typeof t === 'string') return t;
      }
    }
  }
  return '';
}

export function resolveSessionsDir(): string {
  return process.env.PI_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions');
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

type FileAgg = SessionAgg;

/** 异步解析单个 jsonl 文件，返回 [聚合结果, 坏行数] */
async function parseFileAsync(
  fp: string,
  defaultId: string,
  aliases: Record<string, string>,
): Promise<[FileAgg, number]> {
  let cwd = '';
  let sessionId = defaultId;
  let name = '';
  let startTs: string | null = null;
  let endTs: string | null = null;
  let messages = 0;
  let skipped = 0;
  const usage = emptyUsage();
  const dayUsage: Record<string, Usage> = {};
  const modelUsage: Record<string, Usage> = {};
  const modelDayUsage: Record<string, Record<string, Usage>> = {};
  const providerUsage: Record<string, Usage> = {};
  const providerModelUsage: Record<string, Record<string, Usage>> = {};

  let lines: string[] = [];
  try {
    lines = (await readFile(fp, 'utf8')).split('\n');
  } catch {
    if (!name) name = sessionId.slice(0, 8);
    return [
      {
        id: sessionId,
        cwd: '(unknown)',
        name: name.slice(0, 90),
        startTs,
        endTs,
        messages,
        ...usage,
        dayUsage,
        modelUsage,
        modelDayUsage,
        providerUsage,
        providerModelUsage,
      },
      0,
    ];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    if (ts) {
      if (startTs === null) startTs = ts;
      endTs = ts;
    }
    if (e.type === 'session') {
      if (typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
      if (typeof e.id === 'string' && e.id) sessionId = e.id;
    }
    if (e.type === 'message') {
      const m = e.message as Record<string, unknown> | undefined;
      const role = m ? m.role : undefined;
      if (role === 'user' && !name) {
        name = firstText(m?.content).replace(/\s+/g, ' ').trim();
      }
      if (role === 'assistant') messages++;
    }
    const u = getUsage(e);
    if (u) {
      addUsage(usage, u);
      const date = shanghaiDate(ts);
      if (date) addUsage((dayUsage[date] ||= emptyUsage()), u);

      // assistant 消息的用量额外拆到 模型 / 提供商 维度
      const m = e.type === 'message' ? (e.message as Record<string, unknown> | undefined) : undefined;
      if (m && m.role === 'assistant') {
        const rawModel = typeof m.model === 'string' && m.model ? m.model : 'unknown';
        const model = normalizeModelName(rawModel, aliases);
        const provider = typeof m.provider === 'string' && m.provider ? m.provider : 'unknown';
        addUsage((modelUsage[model] ||= emptyUsage()), u);
        if (date) addUsage(((modelDayUsage[model] ||= {})[date] ||= emptyUsage()), u);
        addUsage((providerUsage[provider] ||= emptyUsage()), u);
        addUsage(((providerModelUsage[provider] ||= {})[rawModel] ||= emptyUsage()), u);
      }
    }
  }

  if (!name) name = sessionId.slice(0, 8);
  return [
    {
      id: sessionId,
      cwd: cwd || '(unknown)',
      name: name.slice(0, 90),
      startTs,
      endTs,
      messages,
      ...usage,
      dayUsage,
      modelUsage,
      modelDayUsage,
      providerUsage,
      providerModelUsage,
    },
    skipped,
  ];
}

// 文件级增量缓存：path -> { sig, agg }
const fileCache = new Map<string, { sig: string; agg: FileAgg }>();

async function fileSig(fp: string): Promise<string | null> {
  try {
    const st = await stat(fp);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export async function scan(aliases: Record<string, string> = {}): Promise<ScanResult> {
  const sessionsDir = resolveSessionsDir();
  const sessions: SessionAgg[] = [];
  let skippedLines = 0;
  let scannedFiles = 0;

  let dirs: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    console.error('无法读取会话目录:', sessionsDir, err);
    return {
      generatedAt: new Date().toISOString(),
      sessionsDir,
      sessions: [],
      scannedFiles: 0,
      skippedLines: 0,
    };
  }

  const seen = new Set<string>();
  let sinceYield = 0;

  for (const dir of dirs) {
    const dirPath = join(sessionsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const fn of files) {
      if (!fn.endsWith('.jsonl')) continue;
      const fp = join(dirPath, fn);
      seen.add(fp);

      const defaultId = fn.includes('_')
        ? fn.split('_').slice(1).join('_').replace(/\.jsonl$/, '')
        : fn.replace(/\.jsonl$/, '');

      const sig = await fileSig(fp);
      if (!sig) continue;

      const cached = fileCache.get(fp);
      let agg: FileAgg;
      if (cached && cached.sig === sig && cached.agg) {
        agg = cached.agg;
      } else {
        const [parsed, skipped] = await parseFileAsync(fp, defaultId, aliases);
        agg = parsed;
        skippedLines += skipped;
        fileCache.set(fp, { sig, agg });
        scannedFiles++;
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0;
          await yieldLoop();
        }
      }
      sessions.push({ ...agg });
    }
  }

  // 清理已删除文件的缓存，避免内存无限增长
  for (const k of fileCache.keys()) {
    if (!seen.has(k)) fileCache.delete(k);
  }

  sessions.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
  return {
    generatedAt: new Date().toISOString(),
    sessionsDir,
    sessions,
    scannedFiles,
    skippedLines,
  };
}
