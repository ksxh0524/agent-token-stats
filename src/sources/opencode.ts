// opencode 数据源适配器：扫描 opencode 的 SQLite 数据库（默认
// ~/.local/share/opencode/opencode.db），只读。
//
// 数据模型（opencode 2.0.22 起迁到 v2 表，两套并存）：
//  - 老表 session：id / directory(工作区) / title(会话名) / time_created(ms)
//  - 老表 message：data(JSON)。assistant 消息带 tokens{...}、cost、modelID / providerID
//  - 新表 session_v2：同上，额外有 parent_id / variant / 冗余的 tokens_* 汇总列
//  - 新表 session_message：type 列代替 data.role，模型路径变成 $.model.id / $.model.providerID
//
// ⚠️ 迁移当天（2026-09-29）老表就停止写入了，只读老表会「看起来一切正常、实际漏掉
// 迁移之后全部会话」。实测 session_v2 是老表的严格超集（老表 787 个 id 全部存在于
// session_v2，现共 1079 条），所以 v2 存在时只读 v2；老库（无 v2 表）才回退老表。
//
// 增量策略（两层）：
//  1) db 签名（mtime:size + wal）：opencode 没在跑时签名不变，一个字节都不碰源库。
//  2) 签名变了（opencode 在跑，每轮都变）时**不再全量重扫**：先用覆盖索引按
//     time_created 水位找出「最近动过的会话」，只重建这些会话的聚合，其余直接复用
//     库里已存的 agg。实测 26GB 库：全量 2.4s → 空转 ~0.15s，且没有新消息时
//     0 行 upsert → data_revision 不变 → 前端 ?rev= 增量轮询能命中空载荷。
//
// 归档承诺：opencode 侧删除 session（甚至整库清空重装、换库路径）后，
// 这里已入库的聚合行原样保留并打上 archived 标记，看板历史不丢。
import { DatabaseSync } from 'node:sqlite';
import type { SessionAgg, SourceAdapter, SourceScanOutcome, SourceStat, Usage } from '../types.ts';
import type { ScanStore, UnitRow } from '../store.ts';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { addUsage, aliasHash, emptyUsage, fnv1a, localDate, normalizeModelName, num, str, type RawUsage } from '../util.ts';

export function resolveOpencodeDb(): string {
  return process.env.OPENCODE_DB || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

// 解析口径版本：SQL / 字段解释逻辑变更时 +1
const OPENCODE_PARSER_VERSION = 6;

// 老库（v2 迁移前）：role 在 JSON 里，模型路径是 $.modelID / $.providerID
const LEGACY_MSG_SQL = `
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

// 新库（opencode >= 2.0.22）：role 变成独立 type 列，模型包在 $.model 下。
// 变体（variant）是 $.model.variant 的独立字段，不拼进 id —— 所以 modelUsage
// 的键与老库完全一致，跨迁移期的历史聚合可以无缝接上。
//
// ⚠️ type 必须带上 'compaction'：压缩摘要本身是一次真实计费的 LLM 调用，
// 实测 8 条 compaction 消息带 tokens（4896 input / 18787 output / 3.07M cacheRead），
// 只认 assistant 会把这块从总量里漏掉（老表里 role 只有 assistant 有 token，
// 所以这是 v2 迁移新引入的坑）。
// 其余 type（user/system/synthetic/idle/agent-switched/model-switched）实测一律无 token。
const V2_MSG_SQL = `
SELECT m.session_id            AS sid,
       m.time_created          AS ts,
       json_extract(m.data,'$.cost')                    AS cost,
       json_extract(m.data,'$.model.id')                AS model,
       json_extract(m.data,'$.model.providerID')        AS provider,
       json_extract(m.data,'$.tokens.input')            AS input,
       json_extract(m.data,'$.tokens.output')           AS output,
       json_extract(m.data,'$.tokens.reasoning')        AS reasoning,
       json_extract(m.data,'$.tokens.cache.read')       AS cacheRead,
       json_extract(m.data,'$.tokens.cache.write')      AS cacheWrite,
       NULL                                           AS totalTokens
FROM session_message m
WHERE m.type IN ('assistant','compaction')
  AND json_extract(m.data,'$.tokens') IS NOT NULL
ORDER BY m.session_id, m.time_created`;

// 变更探测：最近动过的会话。走 session_message_time_created_id_idx 覆盖索引，
// 只碰 time_created > 水位的新行，实测 26GB 库上 ~0.14s（对比全量重扫 ~2.4s）。
const V2_TOUCHED_SQL = `SELECT DISTINCT session_id FROM session_message WHERE time_created > ?`;

// 水位回退量：容忍「插入时刻晚于 time_created」的轻微时钟漂移。
// 安全窗口里被重读的行是幂等的 —— 我们按会话整体重建聚合，不会重复计数；
// 再用 per-session mtc 相等判定跳过落库，所以回退量不会造成 revision 空转。
const WM_BACKFILL_MS = 5 * 60 * 1000;

// 时间边界以 session 表为准：time_created / time_updated 是 opencode 自己维护的
// 会话首末时刻，覆盖所有消息（含无 token 的 user / tool 消息）。只用带 token 的
// assistant 消息定界会把开始算晚、结束算早（实测平均偏 0.5 分钟），纯提问会话
// 甚至完全没有时间。
const LEGACY_SESSION_SQL = `SELECT id, directory, title, time_created, time_updated FROM session`;
const V2_SESSION_SQL = `SELECT id, directory, title, time_created, time_updated FROM session_v2`;

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

// v2 迁移后 session_v2 / session_message 才是活表，老表冻结在迁移当天。
// 探一次 sqlite_master 决定读哪套（老库没有这两张表）。
function hasV2Schema(db: DatabaseSync): boolean {
  try {
    const r = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`).get() as
      | Record<string, unknown>
      | undefined;
    return !!r;
  } catch {
    return false;
  }
}

type SessionMeta = { directory: string; title: string; tc: number; tu: number };

// 每个会话的重建结果：聚合 + 该会话最后一条消息的时刻（增量水位）
type Built = { agg: SessionAgg; mtc: number };

type Acc = {
  usage: Usage;
  dayUsage: Record<string, Usage>;
  modelUsage: Record<string, Usage>;
  modelDayUsage: Record<string, Record<string, Usage>>;
  providerUsage: Record<string, Usage>;
  providerModelUsage: Record<string, Record<string, Usage>>;
  startMs: number;
  endMs: number;
  maxMs: number;
  messages: number;
};

function emptyAcc(): Acc {
  return {
    usage: emptyUsage(),
    dayUsage: {},
    modelUsage: {},
    modelDayUsage: {},
    providerUsage: {},
    providerModelUsage: {},
    startMs: Number.MAX_SAFE_INTEGER,
    endMs: 0,
    maxMs: 0,
    messages: 0,
  };
}

function readSessionMeta(db: DatabaseSync, sessionSql: string): Map<string, SessionMeta> {
  const meta = new Map<string, SessionMeta>();
  for (const s of db.prepare(sessionSql).all() as Record<string, unknown>[]) {
    const id = str(s.id);
    if (id) meta.set(id, { directory: str(s.directory), title: str(s.title), tc: num(s.time_created), tu: num(s.time_updated) });
  }
  return meta;
}

/**
 * 把一批消息行累加成「按会话」的中间结果。
 * onlySid 非空时只处理这些会话（增量：只重建动过的会话）。
 */
function accumulate(rows: unknown[], aliases: Record<string, string>, acc: Map<string, Acc>): void {
  for (const raw of rows as MsgRow[]) {
    const sid = str(raw.sid);
    const u = rowToRawUsage(raw);
    const ms = num(raw.ts);
    let a = acc.get(sid);
    if (!a) {
      a = emptyAcc();
      acc.set(sid, a);
    }
    // 水位要覆盖「有行但全零」的会话，否则它会被当成没动过而永久停在旧聚合上
    if (ms > a.maxMs) a.maxMs = ms;
    if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.totalTokens) continue;

    addUsage(a.usage, u);
    a.messages++;
    if (ms > 0) {
      if (ms < a.startMs) a.startMs = ms;
      if (ms > a.endMs) a.endMs = ms;
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
}

/** 中间结果 → SessionAgg（时间边界与 session 表取并集，见文件头注释） */
function finalize(sid: string, a: Acc | undefined, info: SessionMeta | undefined): SessionAgg {
  const tc = info?.tc ?? 0;
  const tu = info?.tu ?? 0;
  const startMs = a && a.startMs > 0 ? Math.min(a.startMs, tc > 0 ? tc : a.startMs) : tc;
  const endMs = a && a.endMs > 0 ? Math.max(a.endMs, tu > 0 ? tu : a.endMs) : tu;
  const u = a?.usage ?? emptyUsage();
  return {
    id: sid,
    source: 'opencode',
    cwd: info?.directory || '(unknown)',
    name: (info?.title || sid.slice(0, 8)).slice(0, 90).replace(/\s+/g, ' ').trim() || sid.slice(0, 8),
    startTs: startMs > 0 ? new Date(startMs).toISOString() : null,
    endTs: endMs > 0 ? new Date(endMs).toISOString() : null,
    messages: a?.messages ?? 0,
    ...u,
    dayUsage: a?.dayUsage ?? {},
    modelUsage: a?.modelUsage ?? {},
    modelDayUsage: a?.modelDayUsage ?? {},
    providerUsage: a?.providerUsage ?? {},
    providerModelUsage: a?.providerModelUsage ?? {},
  };
}

/** 全量重建：一次 SQL 读完所有会话（冷启动 / 口径变更 / 变更面很大时走这里） */
function buildAll(
  db: DatabaseSync,
  meta: Map<string, SessionMeta>,
  msgSql: string,
  aliases: Record<string, string>,
): Map<string, Built> {
  const acc = new Map<string, Acc>();
  accumulate(db.prepare(msgSql).all() as unknown[], aliases, acc);

  const out = new Map<string, Built>();
  // 无 token 消息的会话也保留（0 用量，窗口筛选时自然被排除），与 pi 口径一致
  for (const id of new Set([...meta.keys(), ...acc.keys()])) {
    const a = acc.get(id);
    out.set(id, { agg: finalize(id, a, meta.get(id)), mtc: a?.maxMs ?? 0 });
  }
  return out;
}

/** 增量重建：只读指定会话的消息（走 session_id 索引） */
function buildSome(
  db: DatabaseSync,
  meta: Map<string, SessionMeta>,
  msgSql: string,
  aliases: Record<string, string>,
  sids: string[],
): Map<string, Built> {
  const ph = sids.map(() => '?').join(',');
  const sql = `${msgSql.replace(/ORDER BY[\s\S]*$/, '')} AND m.session_id IN (${ph}) ORDER BY m.session_id, m.time_created`;
  const acc = new Map<string, Acc>();
  accumulate(db.prepare(sql).all(...sids) as unknown[], aliases, acc);

  const out = new Map<string, Built>();
  for (const id of sids) {
    const a = acc.get(id);
    out.set(id, { agg: finalize(id, a, meta.get(id)), mtc: a?.maxMs ?? 0 });
  }
  return out;
}

// 每个 opencode 会话 = 一个 unit（unit = `<db路径>#<sid>`）
const unitKey = (dbPath: string, sid: string) => `${dbPath}#${sid}`;

/**
 * unit 的 ctx（增量状态）。解析不出来 / 形状不对 → 返回 null，本轮按「需要全量重建」
 * 处理并用新形状覆盖，所以升级 ctx 结构不需要额外的迁移步骤。
 *  - m：该会话最后一条消息的 time_created（per-session 增量水位）
 *  - f：session_v2 元信息指纹（title / cwd / time_created / time_updated）
 *
 * db 签名【不放这里】：它是整库级的。放 per-unit 会导致「某个会话被源侧删掉」之后，
 * 那条归档行每轮都要被重新 upsert（为了刷新签名），data_revision 就永远停不下来 ——
 * 而 data_revision 停不下来，前端 ?rev= 增量轮询就永远拿不到空载荷。
 * 签名统一存 meta 表的 `sig:<source>` 键（store.getSourceSig / setSourceSig）。
 */
type OcCtx = { m: number; f: string };

function encodeCtx(c: OcCtx): string {
  return JSON.stringify(c);
}

function decodeCtx(raw: string): OcCtx | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    return { m: Number(o.m) || 0, f: typeof o.f === 'string' ? o.f : '' };
  } catch {
    return null;
  }
}

function metaFp(m: SessionMeta): string {
  return fnv1a(`${m.directory} ${m.title} ${m.tc} ${m.tu}`);
}

// 变更面超过这个比例就退化成一次全量重扫：逐会话查询的固定开销不值得省
const FULL_REBUILD_RATIO = 0.25;
// 单次 IN(...) 的会话数上限（SQLite 变量上限远大于此，留足余量）
const MAX_IN_FILTER = 400;

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

    // 上一轮落库的 ctx（解析失败 = 老版本形状，本轮按需要重建处理）
    const prevCtx = new Map<string, OcCtx>();
    let ctxShapeOk = true;
    for (const [sid, row] of current) {
      const c = decodeCtx(row.ctx);
      if (!c) ctxShapeOk = false;
      else prevCtx.set(sid, c);
    }

    // 快路径：db 签名 + 口径 + 别名都没变，源库一个字节都不碰
    const probeRow = [...current.values()][0];
    if (sig && probeRow && ctxShapeOk && store.getSourceSig('opencode') === sig && probeRow.pv === pv && probeRow.ah === ah) {
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
      // 清掉签名：库没了又回来（重装/换路径）时必须重新扫，不能命中上轮的陈旧签名
      store.setSourceSig('opencode', '');
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
        const v2 = hasV2Schema(db);
        const sessionSql = v2 ? V2_SESSION_SQL : LEGACY_SESSION_SQL;
        const msgSql = v2 ? V2_MSG_SQL : LEGACY_MSG_SQL;
        const meta = readSessionMeta(db, sessionSql);

        // ---- 变更面：哪些会话需要重建 ----
        // 老库（无 v2）没有便宜的水位查询，签名一变就整体重算（这类库早被冻结，量也小）。
        // v2 库走 time_created 水位 + session 元信息指纹，绝大多数轮次是 0 个会话。
        let need: string[];
        let wm = 0;
        for (const [sid, c] of prevCtx) if (c.m > wm) wm = c.m;

        if (!v2 || !ctxShapeOk || current.size === 0) {
          need = [...meta.keys()];
        } else {
          // 指纹变了 = title / cwd / time_created / time_updated 被改过；
          // 水位之后出现过消息 = 有新消息。两者取并集。
          const touched = new Set<string>();
          if (wm > 0) {
            for (const r of db.prepare(V2_TOUCHED_SQL).all(wm - WM_BACKFILL_MS) as Record<string, unknown>[]) {
              const id = str(r.session_id);
              if (id) touched.add(id);
            }
          } else {
            for (const id of meta.keys()) touched.add(id); // 首轮：没有水位可依据
          }
          need = [];
          for (const [id, m] of meta) {
            const c = prevCtx.get(id);
            const fp = metaFp(m);
            const prevRow = current.get(id);
            if (!c || !prevRow) {
              need.push(id); // 新会话（库里没有）
              continue;
            }
            // 口径/别名变了 → 该会话的聚合整体作废重算（归一键依赖别名）
            // prevRow.archived → 源里明明还有这个会话（比如 opencode 恢复了它，或上一轮
            // 误标过），必须重新落库把归档标记清回去，否则会一直灰着。
            if (prevRow.pv !== pv || prevRow.ah !== ah || prevRow.archived || touched.has(id) || c.f !== fp) need.push(id);
          }
        }
        // current 里有、meta 里没有的会话 → 源侧已删，本轮不重建（下面打归档）

        // 查询策略：变更面小就只读那几个会话，大了就一次读完（逐会话查询的固定开销不值得省）。
        // 注意这跟下面的「跳过落库」判定是两件事 —— 走全量查询也完全可以一个字节都不写。
        const tooMany = need.length > MAX_IN_FILTER || need.length > meta.size * FULL_REBUILD_RATIO;
        const built: Map<string, Built> =
          need.length === 0
            ? new Map()
            : tooMany || !v2 || !ctxShapeOk
              ? buildAll(db, meta, msgSql, aliases)
              : buildSome(db, meta, msgSql, aliases, need);

        const rows: UnitRow[] = [];
        for (const [sid, b] of built) {
          const prev = current.get(sid);
          const prevC = prevCtx.get(sid);
          const fp = metaFp(meta.get(sid) ?? { directory: '', title: '', tc: 0, tu: 0 });
          // 只是被安全窗口「误触」、实际没有新消息、指纹也没变的会话：不落库。
          // 这是 data_revision 能在 opencode 运行时保持稳定的关键 ——
          // 一旦这里空转，每轮都会 bump revision，前端 ?rev= 永远拿不到空载荷。
          if (prev && prevC && prevC.m === b.mtc && prevC.f === fp && prev.pv === pv && prev.ah === ah && !prev.archived) {
            continue;
          }
          rows.push({
            source: 'opencode',
            unit: unitKey(dbPath, sid),
            size: 0,
            mtime: 0,
            inode: '',
            offset: 0,
            pv,
            ah,
            ctx: encodeCtx({ m: b.mtc, f: fp }),
            sid,
            agg: b.agg,
            archived: false,
          });
        }
        // 源侧已删的会话：保留聚合并打归档标记（归档承诺）。
        // ⚠️ 判据必须是「session 表里没有了」，**不是**「这轮没重建它」—— 增量的 built
        // 只含动过的会话，拿 built 当判据会把所有没变化的会话误标成归档（踩过）。
        // 已是归档态的行不再重复 upsert，否则 data_revision 每轮都 +1。
        for (const [sid, row] of current) {
          if (meta.has(sid)) continue;
          if (row.archived && row.pv === pv && row.ah === ah) continue;
          rows.push({ ...row, pv, ah, archived: true });
        }
        // 更早库路径留下的 foreign 行一次性把归档列补齐（旧版本归档态写在 agg JSON 里）
        const foreignFix = foreign.filter((r) => !r.archived).map((r) => ({ unit: r.unit, archived: true }));
        if (foreignFix.length) store.setArchived('opencode', foreignFix);
        store.putUnits(rows);
        // 签名写整库级 meta（不 bump data_revision）：数据没变时前端能拿到 unchanged
        store.setSourceSig('opencode', sig);
        scanned = rows.length ? 1 : 0;
        statRes = { location: dbPath, enabled: true, sessions: meta.size || built.size };
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
