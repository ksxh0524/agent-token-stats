// 扫描协调器：遍历数据源适配器，汇总成 /api/data 的载荷。
//
// 架构（为接入新数据源设计）：
//   scan.ts（本文件）   —— 注册表 + 汇总，不认识任何具体数据源的细节
//   sources/pi.ts       —— pi jsonl，字节偏移增量
//   sources/opencode.ts —— opencode SQLite，db 签名增量
//   store.ts            —— 自有 SQLite：聚合结果（含归档）+ 各源扫描游标
//
// 接入新数据源（codex / claude code / ...）：
//   1. 写一个 SourceAdapter 实现放到 src/sources/<name>.ts
//   2. 在下面 ADAPTERS 里加一行
//   3. 前端零改动：来源 tab / meta 行按 /api/data 的 sources key 自动生成
//      （types.ts 的 SourceKind 是开放式联合类型，加名字只是文档性标注）
//
// 通用口径（各源适配器必须遵守，测试盯着这些断言）：
//  - 工作区 = 会话元数据里的 cwd 字段（真实项目路径）
//  - 会话名 = 首条 user 消息的文本摘要
//  - 天 = 按 Asia/Shanghai 时区把 timestamp 归到日期
//  - 模型名归一：去组织前缀（org/model）、小写、冒号转连字符；modelAliases 映射表优先
//  - 费用 = provider 记录的真实费用（usage.cost.total），按 会话/天/模型/提供商 累计
import type { ScanResult, SourceAdapter, SourceStat } from './types.ts';
import { ScanStore } from './store.ts';
import { piAdapter } from './sources/pi.ts';
import { opencodeAdapter } from './sources/opencode.ts';

export { normalizeModelName } from './util.ts';

// 数据源注册表：新数据源在这里加一行即可
const ADAPTERS: SourceAdapter[] = [piAdapter, opencodeAdapter];

let store: ScanStore | null = null;

function getStore(): ScanStore {
  store ??= new ScanStore();
  return store;
}

/** 测试 / 工具用：把扫描库切到指定路径（关闭并替换当前实例） */
export function useStore(dbPath: string): ScanStore {
  store?.close();
  store = new ScanStore(dbPath);
  return store;
}

export async function scan(aliases: Record<string, string> = {}): Promise<ScanResult> {
  const st = getStore();

  // 各源并行扫；单源失败不影响其他源（返回 error stat，库里的归档数据照常输出）
  const results = await Promise.all(
    ADAPTERS.map(async (a) => {
      try {
        return { kind: a.kind, ok: await a.scan(st, aliases), err: null as string | null };
      } catch (err) {
        return { kind: a.kind, ok: null, err: String((err as Error)?.message || err) };
      }
    }),
  );

  const sources: Record<string, SourceStat> = {};
  const sessions: ScanResult['sessions'] = [];
  let scannedFiles = 0;
  let skippedLines = 0;

  for (const r of results) {
    if (r.ok) {
      sources[r.kind] = r.ok.stat;
      sessions.push(...r.ok.sessions);
      scannedFiles += r.ok.scannedUnits;
      skippedLines += r.ok.skippedLines;
    } else {
      // 适配器抛错：该源仍展示库中已有（归档）数据，并在 stat 里带上原因
      sources[r.kind] = {
        location: '',
        enabled: false,
        sessions: st.countSessions(r.kind),
        error: r.err ?? 'unknown error',
      };
    }
  }

  sessions.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
  st.checkpoint(); // WAL 合并回主库，防止无限累积（详见 store.checkpoint）
  return {
    generatedAt: new Date().toISOString(),
    sources: sources as ScanResult['sources'],
    sessions,
    scannedFiles,
    skippedLines,
    revision: String(st.getRevision()),
  };
}
