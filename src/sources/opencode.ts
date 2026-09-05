// opencode 数据源适配器：扫描 opencode 的 SQLite 数据库（默认
// ~/.local/share/opencode/opencode.db），只读。
//
// 数据模型：
//  - session 表：id / directory(工作区) / title(会话名) / time_created(ms)
//  - message 表：data(JSON)。assistant 消息带 tokens{...}、cost、modelID / providerID
//
// 增量策略（db 签名）：opencode.db 只有 3MB 级别，重算本身不慢，所以游标就是
// db(-wal) 的 mtime:size 签名 —— 签名没变就完全不碰源库；变了才重新执行 SQL。
//
// 归档承诺：opencode 侧删除 session（甚至整库清空重装、换库路径）后，
// 这里已入库的聚合行原样保留并打上 archived 标记，看板历史不丢。
import { DatabaseSync } from 'node:sqlite';
import type { SessionAgg, SourceAdapter, SourceScanOutcome, SourceStat, Usage } from '../types.ts';
import type { ScanStore, UnitRow } from '../store.ts';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { addUsage, aliasHash, emptyUsage, localDate, normalizeModelName, num, str, type RawUsage } from '../util.ts';

export function resolveOpencodeDb(): string {
  return process.env.OPENCODE_DB || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

// 解析口径版本：SQL / 字段解释逻辑变更时 +1
const OPENCODE_PARSER_VERSION = 4;

const MSG_SQL = `
SELECT m.session_id            AS sid,
       m.time_created          AS ts,
       json_extract(m.data,'$.cost')                    AS cost,
       json_extract(m.data,'$.modelID')                 AS model,
       json_extract(m.data,'$.providerID')              AS provider,
       json_extract(m.data,'$.tokens.input')            AS input,
       json_extract(m.data,'$.tokens.output')           AS output,
       json_extract(m.data,'$.tokens.reasoning')        AS reasoning,
       json_extract(m.data,'$.tokens.cache.read')       AS cacheRead,
       json_extract(m.data,'$.tokens.cache.write')      AS cacheWrite,
       json_extract(m.data,'$.tokens.total')            AS totalTokens
FROM message m
WHERE json_extract(m.data,'$.role') = 'assistant'
  AND json_extract(m.data,'$.tokens') IS NOT NULL
ORDER BY m.session_id, m.time_created`;

// 时间边界以 session 表为准：time_created / time_updated 是 opencode 自己维护的
// 会话首末时刻，覆盖所有消息（含无 token 的 user / tool 消息）。只用带 token 的
// assistant 消息定界会把开始算晚、结束算早（实测平均偏 0.5 分钟），纯提问会话
// 甚至完全没有时间。
const SESSION_SQL = `SELECT id, directory, title, time_created, time_updated FROM session`;

type MsgRow = {
  sid: unknown;
  ts: unknown;
  cost: unknown;
  model: unknown;
  provider: unknown;
  input: unknown;
  output: unknown;
  reasoning: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
  totalTokens: unknown;
};

function rowToRawUsage(r: MsgRow): RawUsage {
  const input = num(r.input);
  const output = num(r.output);
  const reasoning = num(r.reasoning);
  const cacheRead = num(r.cacheRead);
  const cacheWrite = num(r.cacheWrite);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    // opencode 官方口径（实测 session 表聚合验证）：tokens_output 与 tokens_reasoning
    // 分列存储、互不包含（buzzai/glm 有大量 reasoning>output 的消息），总量必须加上
    // reasoning —— 漏加会把推理 token 整块从总 token 里丢掉（douling 会话少算 14.7 万）。
    // pi 源相反（reasoning ⊆ output 且自带 totalTokens=sum4），由 addUsage 的 tt 优先，
    // 不受此处影响。
    totalTokens: input + output + reasoning + cacheRead + cacheWrite,
    cost: { total: num(r.cost) },
  };
}

async function dbSig(fp: string): Promise<string | null> {
  try {
    const [main, wal] = await Promise.all([stat(fp), stat(`${fp}-wal`).catch(() => null)]);
    const w = wal ? `|${wal.mtimeMs}:${wal.size}` : '';
    return `${main.mtimeMs}:${main.size}${w}`;
  } catch {
    return null;
  }
}

// 只读优先；WAL 模式下若 -shm 不存在只读打开会失败，此时退回普通打开（仅执行 SELECT）
function openDb(fp: string): DatabaseSync {
  try {
    return new DatabaseSync(fp, { readOnly: true });
  } catch {
    return new DatabaseSync(fp);
  }
}

function buildSessions(db: DatabaseSync, aliases: Record<string, string>): Map<string, SessionAgg> {
  const meta = new Map<string, { directory: string; title: string; tc: number; tu: number }>();
  for (const s of db.prepare(SESSION_SQL).all() as Record<string, unknown>[]) {
    const id = str(s.id);
    if (id) meta.set(id, { directory: str(s.directory), title: str(s.title), tc: num(s.time_created), tu: num(s.time_updated) });
  }

  const acc = new Map<
    string,
    {
      usage: Usage;
      dayUsage: Record<string, Usage>;
      modelUsage: Record<string, Usage>;
      modelDayUsage: Record<string, Record<string, Usage>>;
      providerUsage: Record<string, Usage>;
      providerModelUsage: Record<string, Record<string, Usage>>;
      startMs: number;
      endMs: number;
      messages: number;
    }
  >();

  for (const raw of db.prepare(MSG_SQL).all() as unknown as MsgRow[]) {
    const sid = str(raw.sid);
    const u = rowToRawUsage(raw);
    if (!sid || (!u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.totalTokens)) continue;

    let a = acc.get(sid);
    if (!a) {
      a = {
        usage: emptyUsage(),
        dayUsage: {},
        modelUsage: {},
        modelDayUsage: {},
        providerUsage: {},
        providerModelUsage: {},
        startMs: Number.MAX_SAFE_INTEGER,
        endMs: 0,
        messages: 0,
      };
      acc.set(sid, a);
    }

    addUsage(a.usage, u);
    a.messages++;
    const ms = num(raw.ts);
    if (ms > 0) {
      a.startMs = Math.min(a.startMs, ms);
      a.endMs = Math.max(a.endMs, ms);
    }
    const date = localDate(ms > 0 ? new Date(ms).toISOString() : undefined);
    if (date) addUsage((a.dayUsage[date] ||= emptyUsage()), u);

    const model = normalizeModelName(str(raw.model) || 'unknown', aliases);
    const provider = str(raw.provider) || 'unknown';
    addUsage((a.modelUsage[model] ||= emptyUsage()), u);
    if (date) addUsage(((a.modelDayUsage[model] ||= {})[date] ||= emptyUsage()), u);
    addUsage((a.providerUsage[provider] ||= emptyUsage()), u);
    addUsage(((a.providerModelUsage[provider] ||= {})[str(raw.model) || 'unknown'] ||= emptyUsage()), u);
  }

  // 无 token 消息的会话也保留（0 用量，窗口筛选时自然被排除），与 pi 口径一致
  for (const [id, m] of meta) {
    if (!acc.has(id))
      acc.set(id, {
        usage: emptyUsage(),
        dayUsage: {},
        modelUsage: {},
        modelDayUsage: {},
        providerUsage: {},
        providerModelUsage: {},
        startMs: 0,
        endMs: 0,
        messages: 0,
      });
  }

  const sessions = new Map<string, SessionAgg>();
  for (const [sid, a] of acc) {
    const info = meta.get(sid);
    // 时间边界 = 消息首末 与 session.time_created/time_updated 取并集
    const tc = info?.tc ?? 0;
    const tu = info?.tu ?? 0;
    const startMs = a.startMs > 0 ? Math.min(a.startMs, tc > 0 ? tc : a.startMs) : tc;
    const endMs = a.endMs > 0 ? Math.max(a.endMs, tu > 0 ? tu : a.endMs) : tu;
    sessions.set(sid, {
      id: sid,
      source: 'opencode',
      cwd: info?.directory || '(unknown)',
      name: (info?.title || sid.slice(0, 8)).slice(0, 90).replace(/\s+/g, ' ').trim() || sid.slice(0, 8),
      startTs: startMs > 0 ? new Date(startMs).toISOString() : null,
      endTs: endMs > 0 ? new Date(endMs).toISOString() : null,
      messages: a.messages,
      ...a.usage,
      dayUsage: a.dayUsage,
      modelUsage: a.modelUsage,
      modelDayUsage: a.modelDayUsage,
      providerUsage: a.providerUsage,
      providerModelUsage: a.providerModelUsage,
    });
  }
  return sessions;
}

// 每个 opencode 会话 = 一个 unit（unit = `<db路径>#<sid>`，ctx 里存 db 签名）
const unitKey = (dbPath: string, sid: string) => `${dbPath}#${sid}`;

function sortSessions(list: SessionAgg[]): SessionAgg[] {
  return list.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
}

export const opencodeAdapter: SourceAdapter = {
  kind: 'opencode',

  async scan(store: ScanStore, aliases: Record<string, string> = {}): Promise<SourceScanOutcome> {
    const dbPath = resolveOpencodeDb();
    const ah = aliasHash(aliases);
    const pv = OPENCODE_PARSER_VERSION;

    const all = store.getUnits('opencode');
    const current = new Map<string, UnitRow>();
    const foreign: UnitRow[] = []; // 更早的库路径留下的归档行，永远保留展示
    for (const row of all.values()) {
      if (row.unit.startsWith(`${dbPath}#`)) current.set(row.sid, row);
      else foreign.push(row);
    }

    const sig = await dbSig(dbPath);

    // 快路径：签名 + 口径 + 别名都没变，源库一个字节都不碰
    const probe = [...current.values()][0];
    if (sig && probe && probe.ctx === sig && probe.pv === pv && probe.ah === ah) {
      const sessions = sortSessions(
        [...current.values(), ...foreign].map((r) => ({ ...r.agg, archived: r.archived || r.agg.archived === true })),
      );
      return {
        sessions,
        scannedUnits: 0,
        skippedLines: 0,
        stat: { location: dbPath, enabled: true, sessions: sessions.length },
      };
    }

    let scanned = 0;
    let statRes: SourceStat;

    if (!sig) {
      // 源库不存在：归档照常输出，enabled=false。归档翻转落库，增量轮询才能感知到
      const flips = [...current.values()].filter((r) => !r.archived).map((r) => ({ unit: r.unit, archived: true }));
      if (flips.length) store.setArchived('opencode', flips);
      const sessions = sortSessions(
        [...current.values(), ...foreign].map((r) => ({ ...r.agg, archived: true })),
      );
      return {
        sessions,
        scannedUnits: 0,
        skippedLines: 0,
        stat: {
          location: dbPath,
          enabled: false,
          sessions: sessions.length,
          ...(sessions.length ? { error: '源数据库当前不存在，展示的是历史归档' } : {}),
        },
      };
    }

    try {
      const db = openDb(dbPath);
      try {
        const built = buildSessions(db, aliases);
        scanned = 1;

        const rows: UnitRow[] = [];
        // 本轮见过的会话 → upsert（覆盖最新聚合）；没见过的 → 标记归档保留
        for (const [sid, agg] of built) {
          rows.push({
            source: 'opencode',
            unit: unitKey(dbPath, sid),
            size: 0,
            mtime: 0,
            inode: '',
            offset: 0,
            pv,
            ah,
            ctx: sig,
            sid,
            agg,
            archived: false,
          });
        }
        for (const [sid, row] of current) {
          if (!built.has(sid)) rows.push({ ...row, ctx: sig, pv, ah, archived: true });
        }
        // 更早库路径留下的 foreign 行一次性把归档列补齐（旧版本归档态写在 agg JSON 里）
        const foreignFix = foreign.filter((r) => !r.archived).map((r) => ({ unit: r.unit, archived: true }));
        if (foreignFix.length) store.setArchived('opencode', foreignFix);
        store.putUnits(rows);
        statRes = { location: dbPath, enabled: true, sessions: built.size };
      } finally {
        db.close();
      }
    } catch (err) {
      statRes = {
        location: dbPath,
        enabled: false,
        sessions: store.countSessions('opencode'),
        error: String((err as Error)?.message || err),
      };
    }

    const after = store.getUnits('opencode');
    const sessions = sortSessions([...after.values()].map((r) => ({ ...r.agg, archived: r.archived })));
    return {
      sessions,
      scannedUnits: scanned,
      skippedLines: 0,
      stat: statRes,
    };
  },
};
