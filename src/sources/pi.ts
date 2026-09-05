// pi 数据源适配器：扫描 ~/.pi/agent/sessions 下所有 <目录>/<*.jsonl>。
//
// 增量策略（字节偏移）：jsonl 是追加写的，每个文件记录「已解析到第几字节」，
// 下次只从那个位置读新增字节。65MB 的活跃会话追加一行也只解析那几十字节。
//
// 增量基准是【文件维度】：state.agg 保存该文件自己的累计聚合。
// 不能按会话 id 取基准 —— pi 的 resume/分支会让多个 jsonl 指向同一个 id
// （实测 870 文件 → 863 唯一 id），按 id 取 base 会把两个文件的增量
// 合并到同一份聚合上，用量翻倍（踩过的坑）。同 id 的多文件贡献在输出阶段相加。
//
// 归档承诺：pi 清理掉 jsonl 后，units 表里这行（含聚合）原样保留，
// 输出时打上 archived 标记继续展示。
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionAgg, SourceAdapter, SourceScanOutcome, SourceStat, Usage } from '../types.ts';
import type { ScanStore, UnitRow } from '../store.ts';
import {
  addUsage,
  aliasHash,
  emptyUsage,
  isEmptyUsage,
  mergeUsage,
  normalizeModelName,
  localDate,
  type RawUsage,
} from '../util.ts';

export { normalizeModelName } from '../util.ts';

// 解析口径版本：对每行的解释逻辑变更时 +1，让库里旧口径的聚合整体作废
export const PARSER_VERSION = 4;

const CONCURRENCY = 8;

function pickStr(v: unknown): string {
  return typeof v === 'string' && v ? v : '';
}

// 一条事件里的用量可能有好几处，每处各自带模型归属：
//  - e.usage                        顶层（compaction / branch_summary）—— 不带模型
//  - e.message.usage                assistant 消息，或工具内部发起的 LLM 调用（formal_review 等）
//  - e.message.details.results[].usage  subagent 工具：每个子 agent 一条，各带自己的 model
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

// ---------- 解析器上下文：增量解析的「断点状态」 ----------
// 字节偏移只保证从哪读，归因状态（会话元数据 / 最近模型）必须一并持久化，
// 否则增量解析出的用量会归错模型、丢会话名。
interface PiCtx {
  cwd: string;
  sessionId: string;
  sawSessionMeta: boolean;
  name: string;
  needName: boolean;
  startTs: string | null;
  endTs: string | null;
  messages: number;
  lastModel: string;
  lastProvider: string;
  providerByModel: [string, string][];
}

function newCtx(defaultId: string): PiCtx {
  return {
    cwd: '',
    sessionId: defaultId,
    sawSessionMeta: false,
    name: '',
    needName: true,
    startTs: null,
    endTs: null,
    messages: 0,
    lastModel: '',
    lastProvider: '',
    providerByModel: [],
  };
}

function buildAgg(ctx: PiCtx, usage: Usage): SessionAgg {
  return {
    id: ctx.sessionId,
    source: 'pi',
    cwd: ctx.cwd || '(unknown)',
    name: (ctx.name || ctx.sessionId.slice(0, 8)).slice(0, 90),
    startTs: ctx.startTs,
    endTs: ctx.endTs,
    messages: ctx.messages,
    ...usage,
    dayUsage: {},
    modelUsage: {},
    modelDayUsage: {},
    providerUsage: {},
    providerModelUsage: {},
  };
}

/**
 * 解析一批完整行，把用量累进 agg、状态写回 ctx。
 * 增量与全量共用这一段 —— 保证两种路径的口径永远一致。
 */
function parseChunk(
  lines: string[],
  ctx: PiCtx,
  agg: SessionAgg,
  aliases: Record<string, string>,
): number {
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 行级预筛：所有事件行都带 "timestamp"（时间边界必须精确到最后一行），
    // 所以实际上等于全量 JSON.parse；保留判断只是为跳过极少数坏行/空行。
    // 不能为省 CPU 用正则抽 timestamp —— 工具输出文本里可能嵌套带
    // "timestamp" 的 JSON 片段，正则会把嵌套值当事件时间，时间边界反而失真。
    const isCandidate =
      line.includes('"usage"') ||
      line.includes('"assistant"') ||
      line.includes('"timestamp"') ||
      (!ctx.sawSessionMeta && line.includes('"session"')) ||
      (ctx.needName && line.includes('"user"'));
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
      if (ctx.startTs === null) ctx.startTs = ts;
      ctx.endTs = ts;
    }
    if (e.type === 'session') {
      if (typeof e.cwd === 'string' && e.cwd) ctx.cwd = e.cwd;
      if (typeof e.id === 'string' && e.id) ctx.sessionId = e.id;
      ctx.sawSessionMeta = true;
    }
    const m = e.type === 'message' ? (e.message as Record<string, unknown> | undefined) : undefined;
    if (m) {
      const role = m.role;
      if (role === 'user' && ctx.needName) {
        const t = firstText(m.content).replace(/\s+/g, ' ').trim();
        if (t) {
          ctx.name = t;
          ctx.needName = false;
        }
      }
      if (role === 'assistant') {
        ctx.messages++;
        // 记住会话当前模型：compaction 之类不带模型的事件按它归因
        const rm = pickStr(m.model);
        const rp = pickStr(m.provider);
        if (rm) {
          ctx.lastModel = rm;
          if (rp) {
            ctx.lastProvider = rp;
            ctx.providerByModel.push([rm, rp]);
          }
        }
        if (rp) ctx.lastProvider = rp;
      }
    }

    for (const h of collectUsage(e)) {
      addUsage(agg, h.u);
      const date = localDate(ts);
      if (date) addUsage((agg.dayUsage[date] ||= emptyUsage()), h.u);

      // 模型 / 提供商维度：优先用事件自带的模型；
      // compaction 这类没带模型的事件归因到会话内最近一次 assistant 实际用的模型。
      // subagent result 只给模型不给提供商，用同模型已知提供商兜底。
      const rawModel = h.model || ctx.lastModel || 'unknown';
      const provider =
        h.provider ||
        (h.model ? ctx.providerByModel.find(([k]) => k === h.model)?.[1] : ctx.lastProvider) ||
        'unknown';
      const model = normalizeModelName(rawModel, aliases);
      addUsage((agg.modelUsage[model] ||= emptyUsage()), h.u);
      if (date) addUsage(((agg.modelDayUsage[model] ||= {})[date] ||= emptyUsage()), h.u);
      addUsage((agg.providerUsage[provider] ||= emptyUsage()), h.u);
      addUsage(((agg.providerModelUsage[provider] ||= {})[rawModel] ||= emptyUsage()), h.u);
    }
  }
  return skipped;
}

/** 把一段增量聚合合并进本 unit 的累计聚合（时间边界与名称由 finalize 用 ctx 定） */
function mergeAgg(base: SessionAgg, delta: SessionAgg, ctx: PiCtx): void {
  mergeUsage(base, delta);
  const merge1 = (t: Record<string, Usage>, s: Record<string, Usage>) => {
    for (const [k, u] of Object.entries(s)) mergeUsage((t[k] ||= emptyUsage()), u);
  };
  const merge2 = (
    t: Record<string, Record<string, Usage>>,
    s: Record<string, Record<string, Usage>>,
  ) => {
    for (const [k, m] of Object.entries(s)) merge1((t[k] ||= {}), m);
  };
  merge1(base.dayUsage, delta.dayUsage);
  merge1(base.modelUsage, delta.modelUsage);
  merge1(base.providerUsage, delta.providerUsage);
  merge2(base.modelDayUsage, delta.modelDayUsage);
  merge2(base.providerModelUsage, delta.providerModelUsage);

  base.messages = ctx.messages;
  if (ctx.startTs && (!base.startTs || ctx.startTs < base.startTs)) base.startTs = ctx.startTs;
  if (ctx.endTs && (!base.endTs || ctx.endTs > base.endTs)) base.endTs = ctx.endTs;
}

/** 纯聚合合并（输出阶段：同一会话 id 的多个文件贡献相加） */
function addAggInto(base: SessionAgg, delta: SessionAgg): void {
  mergeUsage(base, delta);
  base.messages += delta.messages;
  const merge1 = (t: Record<string, Usage>, s: Record<string, Usage>) => {
    for (const [k, u] of Object.entries(s)) mergeUsage((t[k] ||= emptyUsage()), u);
  };
  const merge2 = (
    t: Record<string, Record<string, Usage>>,
    s: Record<string, Record<string, Usage>>,
  ) => {
    for (const [k, m] of Object.entries(s)) merge1((t[k] ||= {}), m);
  };
  merge1(base.dayUsage, delta.dayUsage);
  merge1(base.modelUsage, delta.modelUsage);
  merge1(base.providerUsage, delta.providerUsage);
  merge2(base.modelDayUsage, delta.modelDayUsage);
  merge2(base.providerModelUsage, delta.providerModelUsage);

  if (delta.startTs && (!base.startTs || delta.startTs < base.startTs)) base.startTs = delta.startTs;
  if (delta.endTs && (!base.endTs || delta.endTs > base.endTs)) base.endTs = delta.endTs;
  // 名字 / cwd：base 为空或还是占位时才采用 delta 的
  if ((!base.name || base.name === base.id.slice(0, 8)) && delta.name) base.name = delta.name;
  if (base.cwd === '(unknown)' && delta.cwd) base.cwd = delta.cwd;
}

/** 从文件的 start 字节读到 end 字节 */
async function readRange(fp: string, start: number, end: number): Promise<Buffer> {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fh = await open(fp, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

interface PiUnit {
  fp: string; // 文件路径（= 扫描单位标识）
  defaultId: string;
  size: number;
  mtime: number;
  ino: string;
}

/** 游标字段全部相同 ⇒ 文件字节没动、解析上下文没动、口径没动 ⇒ 聚合必然相同。
 *  据此跳过无变化行的落库：否则每轮扫描都全量 upsert 几百行 + data_revision 白涨，
 *  前端「数据没变只回空载荷」的增量轮询短路就永远命中不了。
 *  agg 本身不比（stringify 几百份聚合太贵），由游标字段等价性保证。 */
function rowUnchanged(a: UnitRow, b: UnitRow): boolean {
  return (
    a.sid === b.sid &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.inode === b.inode &&
    a.offset === b.offset &&
    a.pv === b.pv &&
    a.ah === b.ah &&
    a.ctx === b.ctx
  );
}

async function listUnits(sessionsDir: string): Promise<{ units: PiUnit[]; error?: string }> {
  let dirs: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    return { units: [], error: String((err as Error)?.message || err) };
  }
  const units: PiUnit[] = [];
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
      const fp = join(sessionsDir, dir, fn);
      try {
        const st = await stat(fp);
        units.push({ fp, defaultId, size: st.size, mtime: st.mtimeMs, ino: String(st.ino) });
      } catch {
        /* stat 失败的文件本轮跳过 */
      }
    }
  }
  return { units };
}

async function processUnit(
  unit: PiUnit,
  state: UnitRow | null,
  ah: string,
  aliases: Record<string, string>,
): Promise<{ row: UnitRow; skipped: number; fullRescan: boolean } | null> {
  // 口径没变、文件没换（inode 相同）、没被截断、上下文完好 → 可以增量；
  // 任一不满足就走全量。宁可多读一遍，也不让归因错乱。
  let ctx: PiCtx | null = null;
  if (
    state &&
    state.pv === PARSER_VERSION &&
    state.ah === ah &&
    state.inode === unit.ino &&
    unit.size >= state.offset &&
    state.agg
  ) {
    try {
      ctx = JSON.parse(state.ctx) as PiCtx;
    } catch {
      ctx = null;
    }
  }
  const canIncremental = !!ctx;
  // 增量基准 = 本文件自己的累计聚合（state.agg），绝不是按会话 id 取的共享聚合
  const baseAgg = canIncremental ? state!.agg : null;

  const startOffset = canIncremental ? state!.offset : 0;
  const buf = await readRange(unit.fp, startOffset, unit.size);
  // 只处理完整行：最后一段没换行符的是 pi 正在写入的半行，留给下一轮
  // （真实 pi 的 jsonl 每条事件都以 \n 结尾，所以这只发生在写入瞬间）
  const lastNl = buf.lastIndexOf(0x0a);
  const consumed = lastNl === -1 ? 0 : lastNl + 1;
  const text = consumed > 0 ? buf.subarray(0, consumed).toString('utf8') : '';
  const lines = text ? text.split('\n') : [];

  let agg: SessionAgg;
  let skipped = 0;

  if (ctx && baseAgg) {
    agg = structuredClone(baseAgg);
    if (lines.length) {
      const delta = buildAgg(ctx, emptyUsage());
      skipped = parseChunk(lines, ctx, delta, aliases);
      mergeAgg(agg, delta, ctx);
    }
  } else {
    // 全量：口径变了 / 文件被换过 / 上下文或历史聚合缺失 / 第一次见到的文件
    ctx = newCtx(unit.defaultId);
    agg = buildAgg(ctx, emptyUsage());
    skipped = parseChunk(lines, ctx, agg, aliases);
  }

  // 收尾：会话名 / cwd / id / 时间边界一律以 ctx 最终状态为准
  agg.id = ctx.sessionId;
  agg.name = (ctx.name || ctx.sessionId.slice(0, 8)).slice(0, 90);
  agg.cwd = ctx.cwd || '(unknown)';
  agg.messages = ctx.messages;
  agg.startTs = ctx.startTs;
  agg.endTs = ctx.endTs;
  agg.archived = false; // 本轮还见得着文件；源里消失与否由 scan 输出阶段统一判定

  return {
    row: {
      source: 'pi',
      unit: unit.fp,
      size: unit.size,
      mtime: unit.mtime,
      inode: unit.ino,
      offset: startOffset + consumed,
      pv: PARSER_VERSION,
      ah,
      ctx: JSON.stringify(ctx),
      sid: agg.id,
      agg,
      archived: false,
    },
    skipped,
    fullRescan: !canIncremental,
  };
}

export const piAdapter: SourceAdapter = {
  kind: 'pi',

  async scan(store: ScanStore, aliases: Record<string, string> = {}): Promise<SourceScanOutcome> {
    const sessionsDir = resolveSessionsDir();
    const { units, error } = await listUnits(sessionsDir);
    const existing = store.getUnits('pi'); // 含归档行（源里已删的文件）

    if (error && !units.length) {
      // 会话目录读不了（被移动/权限）：归档数据照常输出
      return {
        sessions: groupBySession(existing),
        scannedUnits: 0,
        skippedLines: 0,
        stat: { location: sessionsDir, enabled: false, sessions: store.countSessions('pi'), error },
      };
    }

    const ah = aliasHash(aliases);
    const seenUnits = new Set(units.map((u) => u.fp));

    const changedRows: UnitRow[] = [];
    let skippedLines = 0;
    let fullRescans = 0;
    let sinceYield = 0;

    const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

    // worker 池并发解析
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, units.length || 1) }, async () => {
      while (idx < units.length) {
        const unit = units[idx++];
        try {
          const res = await processUnit(unit, existing.get(unit.fp) ?? null, ah, aliases);
          if (!res) continue;
          // 无变化的行不写库（不涨 data_revision、不产生 WAL），只有真变化才落库
          const prev = existing.get(unit.fp);
          if (prev && rowUnchanged(prev, res.row)) continue;
          changedRows.push(res.row);
          skippedLines += res.skipped;
          if (res.fullRescan) fullRescans++;
          if (++sinceYield >= 40) {
            sinceYield = 0;
            await yieldLoop(); // 让出事件循环，扫描期间服务仍可响应
          }
        } catch {
          /* 单文件失败不拖垮整体 */
        }
      }
    });
    await Promise.all(workers);

    // 只写本轮有变化的行；源里消失的行不动（它们就是归档）
    store.putUnits(changedRows);

    // 输出 = 全部 unit（本轮更新过的用内存里的新值 + 未变的历史值 + 归档）按会话 id 相加
    const merged = new Map(existing);
    for (const row of changedRows) merged.set(row.unit, row);

    // 归档判定以「源里是否还有这个文件」为准，并把翻转落库：
    // 不落库的话，增量轮询的版本号就感知不到「文件被删 → 会话转归档」这件事
    const archiveChanges: { unit: string; archived: boolean }[] = [];
    for (const row of merged.values()) {
      const target = !seenUnits.has(row.unit);
      row.agg.archived = target;
      if (!!row.archived !== target) {
        archiveChanges.push({ unit: row.unit, archived: target });
        row.archived = target;
      }
    }
    if (archiveChanges.length) store.setArchived('pi', archiveChanges);

    const sessions = groupBySession(merged);

    const stat: SourceStat = {
      location: sessionsDir,
      enabled: true,
      sessions: store.countSessions('pi'),
    };
    return {
      sessions,
      scannedUnits: fullRescans,
      skippedLines,
      stat,
    };
  },
};

/** 同一会话 id 的多个文件贡献相加（pi resume/分支会让多个 jsonl 指向同一 id）。
 *  归档标记 = 该会话的全部贡献都是归档（只要有一个文件还在源里就算活跃）。 */
function groupBySession(rows: Map<string, UnitRow>): SessionAgg[] {
  const byId = new Map<string, { agg: SessionAgg; archived: boolean }>();
  for (const row of rows.values()) {
    const b = byId.get(row.agg.id);
    if (b) {
      addAggInto(b.agg, row.agg);
      b.archived = b.archived && !!row.agg.archived;
    } else {
      byId.set(row.agg.id, { agg: structuredClone(row.agg), archived: !!row.agg.archived });
    }
  }
  const out: SessionAgg[] = [];
  for (const [id, { agg, archived }] of byId) {
    if (archived) agg.archived = true;
    out.push(agg);
  }
  out.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
  return out;
}
