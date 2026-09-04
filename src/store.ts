// 本项目自有的持久化数据库 —— 唯一的数据事实来源（source of truth）。
//
// 设计目标（全是踩出来的）：
//  1. 数据不随源消失：pi 会清理 jsonl，opencode 会删 session。扫描单位（unit）
//     的聚合结果一旦入库就长期保留 —— 源删了，历史统计照样在（归档承诺）。
//  2. 增量扫描：jsonl 是追加写的，每个 unit 记录「已解析到第几字节」（offset）
//     与解析器上下文（ctx），下次只解析新增字节，扫过的内容一个字节不重读。
//  3. 可扩展：接入新数据源（codex / claude code / ...）= 加一个适配器文件，
//     库结构不用动。
//
// 关键语义（important）：
//  - 聚合的增量基准是【unit 维度】（pi = 一个 jsonl 文件），不是会话 id 维度。
//    因为 pi 的 resume/分支会让多个 jsonl 的 session 事件指向同一个 id
//    （实测 870 个文件 → 863 个唯一 id）。base 若按 id 取，两个文件的增量
//    会合并到同一份聚合上，用量翻倍 —— 这是真实踩过的坑。
//  - 同 id 的多个 unit 贡献在【输出时】相加（见 sources/pi.ts 的 groupBySession），
//    这样既保证总量正确，又保持每个 unit 的增量独立性。
//  - unit 的源文件被删除时，该行【不删除】—— 它就是归档。文件重新出现
//    （同 inode）增量继续；被换成新文件（不同 inode）时全量重扫并覆盖本行。
//
// 表结构：
//  - units        每个扫描单位的游标 + 该单位的累计聚合（含已归档的）
//  - meta         schema 版本 + data_revision（数据版本号，见下）
//
// data_revision：任何「会影响 /api/data 输出」的落库变化都 +1（unit 聚合更新、
// 归档状态翻转）。服务端拿它和价格配置指纹拼成复合版本号，前端轮询带上
// 上次的版本号 —— 数据没变就只回几百字节，不再传几 MB 的会话大载荷。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionAgg, SourceKind } from './types.ts';

export const SCHEMA_VERSION = 3;

export function defaultStoreFile(): string {
  return process.env.PI_SCAN_DB || fileURLToPath(new URL('../.cache/store.db', import.meta.url));
}

export interface UnitRow {
  source: SourceKind;
  unit: string; // 扫描单位标识：pi = jsonl 绝对路径；opencode = db 路径
  size: number;
  mtime: number;
  inode: string; // 「同路径换了新文件」检测：inode 变了必须全量重扫本 unit
  offset: number; // pi: 已解析字节偏移；其他源自定义
  pv: number; // 解析口径版本
  ah: string; // 模型别名配置哈希（归一键名依赖它）
  ctx: string; // 适配器的解析器上下文 JSON（恢复增量解析状态用）
  sid: string; // 该 unit 当前归属的会话 id（unit.agg 的 key）
  agg: SessionAgg; // 该 unit 的累计聚合（增量 merge 的权威基准）
  archived: boolean; // 源里已无此 unit（聚合保留展示）；落库列，归档翻转会计入数据版本
}

export class ScanStore {
  private db: DatabaseSync;
  private readonly allStmt;
  private readonly upsertStmt;
  private readonly countSidStmt;
  private readonly revisionStmt;
  private readonly setArchivedStmt;

  constructor(dbPath: string = defaultStoreFile()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openWithRetry(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        source   TEXT    NOT NULL,
        unit     TEXT    NOT NULL,
        size     INTEGER NOT NULL,
        mtime    REAL    NOT NULL,
        inode    TEXT    NOT NULL,
        offset   INTEGER NOT NULL,
        pv       INTEGER NOT NULL,
        ah       TEXT    NOT NULL,
        ctx      TEXT    NOT NULL,
        sid      TEXT    NOT NULL,
        agg      TEXT    NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, unit)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    const v = Number(this.getMeta('schema_version') ?? 0);
    if (v !== SCHEMA_VERSION) {
      if (v > 0 && v < SCHEMA_VERSION) {
        // 小版本升级：尽力 ALTER 保留已积累的聚合（迁移失败再整体重建）
        try {
          this.db.exec('ALTER TABLE units ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
        } catch {
          /* 列已存在等情况，忽略 */
        }
      } else {
        this.db.exec('DROP TABLE IF EXISTS units');
        this.db.exec(`
          CREATE TABLE units (
            source   TEXT    NOT NULL,
            unit     TEXT    NOT NULL,
            size     INTEGER NOT NULL,
            mtime    REAL    NOT NULL,
            inode    TEXT    NOT NULL,
            offset   INTEGER NOT NULL,
            pv       INTEGER NOT NULL,
            ah       TEXT    NOT NULL,
            ctx      TEXT    NOT NULL,
            sid      TEXT    NOT NULL,
            agg      TEXT    NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source, unit)
          ) WITHOUT ROWID;
        `);
      }
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
    this.allStmt = this.db.prepare('SELECT source, unit, size, mtime, inode, offset, pv, ah, ctx, sid, agg, archived FROM units WHERE source = ?');
    this.upsertStmt = this.db.prepare(
      `INSERT INTO units (source, unit, size, mtime, inode, offset, pv, ah, ctx, sid, agg, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, unit) DO UPDATE SET
         size = excluded.size, mtime = excluded.mtime, inode = excluded.inode,
         offset = excluded.offset, pv = excluded.pv, ah = excluded.ah,
         ctx = excluded.ctx, sid = excluded.sid, agg = excluded.agg,
         archived = excluded.archived`,
    );
    this.countSidStmt = this.db.prepare(
      'SELECT COUNT(DISTINCT sid) AS n FROM units WHERE source = ?',
    );
    this.revisionStmt = this.db.prepare(
      `INSERT INTO meta (key, value) VALUES ('data_revision', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    );
    this.setArchivedStmt = this.db.prepare('UPDATE units SET archived = ? WHERE source = ? AND unit = ?');
  }

  private getMeta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** 一个数据源的全部 unit 行（含源文件已删除的归档行） */
  getUnits(source: SourceKind): Map<string, UnitRow> {
    const out = new Map<string, UnitRow>();
    for (const row of this.allStmt.all(source) as unknown as (Omit<UnitRow, 'agg' | 'archived'> & { agg: string; archived: number })[]) {
      try {
        out.set(row.unit, {
          ...row,
          source: row.source as SourceKind,
          agg: JSON.parse(row.agg) as SessionAgg,
          archived: !!Number(row.archived),
        });
      } catch {
        /* 单行坏数据只作废这一行 */
      }
    }
    return out;
  }

  putUnits(rows: Iterable<UnitRow>): void {
    const list = [...rows];
    if (!list.length) return;
    this.db.exec('BEGIN');
    try {
      for (const r of list) {
        this.upsertStmt.run(
          r.source,
          r.unit,
          r.size,
          r.mtime,
          r.inode,
          r.offset,
          r.pv,
          r.ah,
          r.ctx,
          r.sid,
          JSON.stringify(r.agg),
          r.archived ? 1 : 0,
        );
      }
      this.revisionStmt.run(); // 有实际落库变化 → 数据版本 +1
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 可能已自动回滚 */
      }
      throw err;
    }
  }

  /** 数据版本号：任何影响输出的落库变化都会使其递增（详见文件头注释） */
  getRevision(): number {
    return Number(this.getMeta('data_revision') ?? 0);
  }

  /** 批量翻转归档状态；有实际翻转才 +1 版本。供适配器在输出阶段同步归档态用 */
  setArchived(source: SourceKind, changes: Iterable<{ unit: string; archived: boolean }>): void {
    const list = [...changes];
    if (!list.length) return;
    this.db.exec('BEGIN');
    try {
      for (const c of list) this.setArchivedStmt.run(c.archived ? 1 : 0, source, c.unit);
      this.revisionStmt.run();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 可能已自动回滚 */
      }
      throw err;
    }
  }

  /** 唯一会话数（同 id 多 unit 只算一个） */
  countSessions(source: SourceKind): number {
    const row = this.countSidStmt.get(source) as { n: number };
    return Number(row?.n ?? 0);
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 可能已自动回滚 */
      }
      throw err;
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* 合并失败不影响正确性 */
    }
    this.db.close();
  }

  /** 把 WAL 合并回主库并截断。scan 后调用：WAL 否则会无限累积（stop 的 800ms 退出
   *  兜底经常赶不上 close() 里的 checkpoint），新进程打开时还要回放整个 WAL */
  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* 有并发连接时可能 busy，下一轮再合，无害 */
    }
  }
}

/** 库文件损坏时重建一次，别让一次坏盘把整个看板搞挂 */
function openWithRetry(dbPath: string): DatabaseSync {
  try {
    return new DatabaseSync(dbPath);
  } catch {
    try {
      for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    } catch {
      /* 删不掉就直接让它抛 */
    }
    return new DatabaseSync(dbPath);
  }
}
