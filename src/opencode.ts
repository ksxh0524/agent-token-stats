// 扫描 opencode 的 SQLite 数据库（默认 ~/.local/share/opencode/opencode.db），只读。
// 数据模型：
//  - session 表：id / directory(工作区) / title(会话名) / time_created(ms)
//  - message 表：data(JSON)。assistant 消息带 tokens{input,output,reasoning,cache.read,cache.write,total}、
//    cost(provider 记录的真实费用)、modelID / providerID、time.created(ms)
// 性能：
//  - 库级增量缓存（db + wal 的 mtime:size 签名），没变直接复用整份结果
//  - 字段全部在 SQL 里用 json_extract 抽好，JS 侧只做累加
import { DatabaseSync } from 'node:sqlite';
import type { SessionAgg, SourceStat, Usage } from './types.ts';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { addUsage, aliasHash, emptyUsage, normalizeModelName, num, shanghaiDate, str, type RawUsage } from './util.ts';

export function resolveOpencodeDb(): string {
  return process.env.OPENCODE_DB || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

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

const SESSION_SQL = `SELECT id, directory, title FROM session`;

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
  return {
    input: num(r.input),
    output: num(r.output),
    reasoning: num(r.reasoning),
    cacheRead: num(r.cacheRead),
    cacheWrite: num(r.cacheWrite),
    totalTokens: num(r.totalTokens),
    cost: { total: num(r.cost) },
  };
}

export interface OpencodeScan {
  sessions: SessionAgg[];
  skippedLines: number;
  stat: SourceStat;
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

function buildSessions(db: DatabaseSync, aliases: Record<string, string>): { sessions: SessionAgg[]; skipped: number } {
  const meta = new Map<string, { directory: string; title: string }>();
  for (const s of db.prepare(SESSION_SQL).all() as Record<string, unknown>[]) {
    const id = str(s.id);
    if (id) meta.set(id, { directory: str(s.directory), title: str(s.title) });
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
    if (!a)
      acc.set(
        sid,
        (a = {
          usage: emptyUsage(),
          dayUsage: {},
          modelUsage: {},
          modelDayUsage: {},
          providerUsage: {},
          providerModelUsage: {},
          startMs: Number.MAX_SAFE_INTEGER,
          endMs: 0,
          messages: 0,
        }),
      );

    addUsage(a.usage, u);
    a.messages++;
    const ms = num(raw.ts);
    if (ms > 0) {
      a.startMs = Math.min(a.startMs, ms);
      a.endMs = Math.max(a.endMs, ms);
    }
    const date = shanghaiDate(ms > 0 ? new Date(ms).toISOString() : undefined);
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

  const sessions: SessionAgg[] = [];
  for (const [sid, a] of acc) {
    const info = meta.get(sid);
    sessions.push({
      id: sid,
      source: 'opencode',
      cwd: info?.directory || '(unknown)',
      name: (info?.title || sid.slice(0, 8)).slice(0, 90).replace(/\s+/g, ' ').trim() || sid.slice(0, 8),
      startTs: a.startMs > 0 ? new Date(a.startMs).toISOString() : null,
      endTs: a.endMs > 0 ? new Date(a.endMs).toISOString() : null,
      messages: a.messages,
      ...a.usage,
      dayUsage: a.dayUsage,
      modelUsage: a.modelUsage,
      modelDayUsage: a.modelDayUsage,
      providerUsage: a.providerUsage,
      providerModelUsage: a.providerModelUsage,
    });
  }
  return { sessions, skipped: 0 };
}

// 库级缓存：签名（mtime+size，含 -wal）没变则整份复用
let cache: { key: string; res: OpencodeScan } | null = null;

export async function scanOpencodeSessions(aliases: Record<string, string> = {}): Promise<OpencodeScan> {
  const dbPath = resolveOpencodeDb();
  const sig = await dbSig(dbPath);
  // 库签名 + 别名哈希共同构成缓存键（别名影响模型归一键名）
  const key = sig ? `${sig}|${aliasHash(aliases)}` : null;
  if (key && cache && cache.key === key) return cache.res;

  let res: OpencodeScan;
  if (!sig) {
    res = { sessions: [], skippedLines: 0, stat: { location: dbPath, enabled: false, sessions: 0 } };
  } else {
    try {
      const db = openDb(dbPath);
      try {
        const built = buildSessions(db, aliases);
        res = {
          sessions: built.sessions.sort((x, y) => (y.startTs || '').localeCompare(x.startTs || '')),
          skippedLines: built.skipped,
          stat: { location: dbPath, enabled: true, sessions: built.sessions.length },
        };
      } finally {
        db.close();
      }
    } catch (err) {
      res = {
        sessions: [],
        skippedLines: 0,
        stat: { location: dbPath, enabled: false, sessions: 0, error: String((err as Error)?.message || err) },
      };
    }
  }
  if (key) cache = { key, res };
  return res;
}
