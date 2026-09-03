// pi 数据源：扫描 ~/.pi/agent/sessions 下所有 <目录>/<*.jsonl>，解析每条带 usage 的事件，聚合成 SessionAgg。
// 并在此合并 opencode 数据源（opencode.ts），统一输出 ScanResult。
// 关键约定：
//  - 工作区 = session 事件的 cwd 字段（真实项目路径，比反解文件夹名靠谱）
//  - 会话名 = 首条 user 消息的文本摘要
//  - 天 = 按 Asia/Shanghai 时区把 timestamp 归到日期
//  - 模型名归一：去组织前缀（org/model）、小写、冒号转连字符；modelAliases 映射表优先
//  - 费用：usage.cost.total 为 provider 记录的真实费用，按 会话/天/模型/提供商 四维度累计
//
// 性能（首扫加速三件套）：
//  - 行级预筛：不含 "usage" 的纯文本行直接跳过 JSON.parse（用户消息占大头）
//  - 并发解析：worker 池并行处理文件，IO/解析重叠
//  - 磁盘持久缓存：<sig, 别名哈希> 未变的文件重启后直接复用聚合结果（原子写盘）
import type { SessionAgg, ScanResult, SourceStat, Usage } from './types.ts';
import { readdir, readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  addUsage,
  aliasHash,
  emptyUsage,
  isEmptyUsage,
  normalizeModelName,
  shanghaiDate,
  type RawUsage,
} from './util.ts';
import { scanOpencodeSessions } from './opencode.ts';

export { normalizeModelName } from './util.ts';

const YIELD_EVERY = 40;
const CONCURRENCY = 8;
const DISK_CACHE_MAX_ENTRIES = 20000;
// 解析口径版本：解析逻辑变更时 +1，让磁盘缓存里旧口径的结果整体失效
const PARSER_VERSION = 2;

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function pickStr(v: unknown): string {
  return typeof v === 'string' && v ? v : '';
}

// 一条事件里的用量可能有好几处，每处各自带模型归属：
//  - e.usage                        顶层（compaction / branch_summary）—— 不带模型
//  - e.message.usage                assistant 消息，或工具内部发起的 LLM 调用（formal_review 等）
//  - e.message.details.results[].usage  subagent 工具：每个子 agent 一条，各带自己的 model
// 返回每条用量 + 它的模型/提供商（拿不到就是空串，交给调用方归因）
interface UsageHit {
  u: RawUsage;
  model: string;
  provider: string;
}

function collectUsage(e: Record<string, unknown>): UsageHit[] {
  const hits: UsageHit[] = [];
  const push = (u: RawUsage | undefined, model = '', provider = '') => {
    if (!u || isEmptyUsage(u)) return;
    hits.push({ u, model, provider });
  };

  push(e.usage as RawUsage | undefined);

  const msg = e.message as Record<string, unknown> | undefined;
  if (msg) {
    const d = msg.details as Record<string, unknown> | undefined;
    push(
      msg.usage as RawUsage | undefined,
      pickStr(msg.model) || pickStr(d?.model),
      pickStr(msg.provider) || pickStr(d?.provider),
    );

    // subagent：results 里每个子 agent 一条用量，模型只在 result 上，不在 message 上
    if (msg.toolName === 'subagent') {
      const results = d?.results;
      if (Array.isArray(results)) {
        for (const r of results) {
          if (!r || typeof r !== 'object') continue;
          const rec = r as Record<string, unknown>;
          push(rec.usage as RawUsage | undefined, pickStr(rec.model), pickStr(rec.provider));
        }
      }
    }
  }
  return hits;
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

type FileAgg = SessionAgg;

/** 异步解析单个 jsonl 文件，返回 [聚合结果, 坏行数] */
async function parseFileAsync(
  fp: string,
  defaultId: string,
  aliases: Record<string, string>,
): Promise<[FileAgg, number]> {
  let cwd = '';
  let sessionId = defaultId;
  let sawSessionMeta = false; // 已捕获 session 元数据行
  let name = '';
  let needName = true; // 还没找到首条 user 消息
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
  // 会话内最近一次 assistant 所用的模型/提供商（原始名），以及 原始模型名 → 提供商 的已知映射
  let lastModel = '';
  let lastProvider = '';
  const providerByModel = new Map<string, string>();

  const blank = (): FileAgg => ({
    id: sessionId,
    source: 'pi',
    cwd: cwd || '(unknown)',
    name: (name || sessionId.slice(0, 8)).slice(0, 90),
    startTs,
    endTs,
    messages,
    ...usage,
    dayUsage,
    modelUsage,
    modelDayUsage,
    providerUsage,
    providerModelUsage,
  });

  let lines: string[];
  try {
    lines = (await readFile(fp, 'utf8')).split('\n');
  } catch {
    return [blank(), 0];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 行级预筛：带 usage 的行必含字面量 "usage"；assistant 行含 "role":"assistant"
    // （保消息计数与时间戳精确）。只跳过占大头的纯用户输入文本行。
    const isCandidate =
      line.includes('"usage"') ||
      line.includes('"assistant"') ||
      (!sawSessionMeta && line.includes('"session"')) ||
      (needName && line.includes('"user"'));
    if (!isCandidate) continue;

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
      sawSessionMeta = true;
    }
    const m = e.type === 'message' ? (e.message as Record<string, unknown> | undefined) : undefined;
    if (m) {
      const role = m.role;
      if (role === 'user' && needName) {
        const t = firstText(m.content).replace(/\s+/g, ' ').trim();
        if (t) {
          name = t;
          needName = false;
        }
      }
      if (role === 'assistant') {
        messages++;
        // 记住会话当前模型：compaction 之类不带模型的事件按它归因
        const rm = pickStr(m.model);
        const rp = pickStr(m.provider);
        if (rm) {
          lastModel = rm;
          if (rp) providerByModel.set(rm, rp);
        }
        if (rp) lastProvider = rp;
      }
    }

    // 一条事件可能承载多处用量（assistant / subagent results / 工具内调用 / compaction）
    for (const h of collectUsage(e)) {
      addUsage(usage, h.u);
      const date = shanghaiDate(ts);
      if (date) addUsage((dayUsage[date] ||= emptyUsage()), h.u);

      // 模型 / 提供商维度：优先用事件自带的模型；
      // compaction 这类没带模型的事件归因到会话内最近一次 assistant 实际用的模型。
      // subagent result 只给模型不给提供商，用同模型已知提供商兜底。
      const rawModel = h.model || lastModel || 'unknown';
      // 自带模型的（subagent / 工具内调用）只认该模型已知提供商，不去蹭主会话的 provider；
      // 不带模型的（compaction）才是主会话自己干的，用最近一次 assistant 的提供商
      const provider = h.provider || (h.model ? providerByModel.get(h.model) : lastProvider) || 'unknown';
      const model = normalizeModelName(rawModel, aliases);
      addUsage((modelUsage[model] ||= emptyUsage()), h.u);
      if (date) addUsage(((modelDayUsage[model] ||= {})[date] ||= emptyUsage()), h.u);
      addUsage((providerUsage[provider] ||= emptyUsage()), h.u);
      addUsage(((providerModelUsage[provider] ||= {})[rawModel] ||= emptyUsage()), h.u);
    }
  }

  return [{ ...blank(), name: (name || sessionId.slice(0, 8)).slice(0, 90) }, skipped];
}

// ---------- 两级缓存：内存 + 磁盘 ----------
interface CacheEntry {
  sig: string; // mtime:size
  ah: string; // 别名配置哈希（别名变了结果键名会变，必须失效）
  pv: number; // 解析口径版本（解析逻辑变了结果内容会变，必须失效）
  agg: FileAgg;
}
const memCache = new Map<string, CacheEntry>();
let diskLoaded = false;
let diskDirty = false;

function resolveDiskCacheFile(): string {
  return process.env.PI_SCAN_CACHE || fileURLToPath(new URL('../.cache/pi-scan-cache.json', import.meta.url));
}

async function loadDiskCache(): Promise<void> {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const j = JSON.parse(await readFile(resolveDiskCacheFile(), 'utf8')) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(j)) {
      if (v && typeof v.sig === 'string' && typeof v.ah === 'string' && v.pv === PARSER_VERSION && v.agg)
        memCache.set(k, v);
    }
  } catch {
    /* 无缓存或坏缓存：冷启动 */
  }
}

async function flushDiskCache(seen: Set<string>, ah: string): Promise<void> {
  if (!diskDirty) return;
  diskDirty = false;
  for (const k of [...memCache.keys()]) if (!seen.has(k)) memCache.delete(k);
  if (memCache.size > DISK_CACHE_MAX_ENTRIES) return; // 异常膨胀时放弃本次持久化
  try {
    const obj: Record<string, CacheEntry> = {};
    // 只持久化当前别名 + 当前解析口径的结果，其余下次启动自然重算
    for (const [k, v] of memCache) if (v.ah === ah && v.pv === PARSER_VERSION) obj[k] = v;
    const fp = resolveDiskCacheFile();
    await mkdir(dirname(fp), { recursive: true });
    const tmp = `${fp}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(obj));
    await rename(tmp, fp);
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

async function fileSig(fp: string): Promise<string | null> {
  try {
    const st = await stat(fp);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

interface PiScan {
  sessions: SessionAgg[];
  stat: SourceStat;
  scannedFiles: number;
  skippedLines: number;
}

async function scanPiSessions(aliases: Record<string, string> = {}): Promise<PiScan> {
  const sessionsDir = resolveSessionsDir();

  let dirs: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    return {
      sessions: [],
      stat: { location: sessionsDir, enabled: false, sessions: 0, error: String((err as Error)?.message || err) },
      scannedFiles: 0,
      skippedLines: 0,
    };
  }

  // 收集全部待扫文件（目录层保持串行小开销，文件处理交给并发池）
  const files: { fp: string; defaultId: string }[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(join(sessionsDir, dir));
    } catch {
      continue;
    }
    for (const fn of names) {
      if (!fn.endsWith('.jsonl')) continue;
      const defaultId = fn.includes('_')
        ? fn.split('_').slice(1).join('_').replace(/\.jsonl$/, '')
        : fn.replace(/\.jsonl$/, '');
      files.push({ fp: join(sessionsDir, dir, fn), defaultId });
    }
  }

  await loadDiskCache();
  const ah = aliasHash(aliases);

  const sessions: SessionAgg[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let skippedLines = 0;
  let sinceYield = 0;

  async function processFile(fp: string, defaultId: string): Promise<void> {
    seen.add(fp);
    const sig = await fileSig(fp);
    if (!sig) return;

    const cached = memCache.get(fp);
    if (cached && cached.sig === sig && cached.ah === ah && cached.pv === PARSER_VERSION) {
      sessions.push({ ...cached.agg });
      return;
    }

    const [agg, skipped] = await parseFileAsync(fp, defaultId, aliases);
    skippedLines += skipped;
    scannedFiles++;
    memCache.set(fp, { sig, ah, pv: PARSER_VERSION, agg });
    diskDirty = true;
    sessions.push({ ...agg });

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      await yieldLoop(); // 让出事件循环，扫描期间服务仍可响应
    }
  }

  // worker 池并发解析
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (idx < files.length) {
      const t = files[idx++];
      try {
        await processFile(t.fp, t.defaultId);
      } catch {
        /* 单文件失败不拖垮整体 */
      }
    }
  });
  await Promise.all(workers);
  await flushDiskCache(seen, ah);

  sessions.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
  return {
    sessions,
    stat: { location: sessionsDir, enabled: true, sessions: sessions.length },
    scannedFiles,
    skippedLines,
  };
}

// 合并所有数据源：pi (jsonl) + opencode (SQLite)
export async function scan(aliases: Record<string, string> = {}): Promise<ScanResult> {
  const [pi, oc] = await Promise.all([scanPiSessions(aliases), scanOpencodeSessions(aliases)]);
  const sessions = [...pi.sessions, ...oc.sessions].sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
  return {
    generatedAt: new Date().toISOString(),
    sources: { pi: pi.stat, opencode: oc.stat },
    sessions,
    scannedFiles: pi.scannedFiles,
    skippedLines: pi.skippedLines + oc.skippedLines,
  };
}
