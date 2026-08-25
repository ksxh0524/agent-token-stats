// 扫描 ~/.pi/agent/sessions 下所有 *.jsonl，解析每条带 usage 的事件，聚合成 SessionAgg。
// 关键约定：
//  - 工作区 = session 事件的 cwd 字段（真实项目路径，比反解文件夹名靠谱）
//  - 会话名 = 首条 user 消息的文本摘要
//  - 天 = 按 Asia/Shanghai 时区把 timestamp 归到日期
//
// 性能：每个 jsonl 文件按「mtime:size」签名做文件级增量缓存。
// 没变化的文件直接复用上次解析结果，只重解析新增/改动的文件。
// 首次全量解析约 3~4s；之后日常刷新（文件基本不变）仅 stat + 跳过，几十毫秒级。
import type { SessionAgg, ScanResult, Usage } from './types.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type RawUsage = Partial<Usage>;

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addUsage(acc: Usage, u: RawUsage | null | undefined): void {
  if (!u) return;
  acc.input += u.input ?? 0;
  acc.output += u.output ?? 0;
  acc.cacheRead += u.cacheRead ?? 0;
  acc.cacheWrite += u.cacheWrite ?? 0;
  acc.totalTokens += u.totalTokens ?? 0;
}

// usage 可能在顶层（compaction / branch_summary），也可能嵌在 message 里（assistant / tool）
function getUsage(e: any): RawUsage | null {
  if (e && e.usage) return e.usage as RawUsage;
  if (e && e.message && e.message.usage) return e.message.usage as RawUsage;
  return null;
}

function shanghaiDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}

function firstText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return '';
}

function resolveSessionsDir(): string {
  return process.env.PI_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions');
}

// ---------- 单个文件的解析结果（缓存单位）----------
interface FileAgg {
  id: string;
  cwd: string;
  name: string;
  startTs: string | null;
  endTs: string | null;
  messages: number;
  usage: Usage;
  dayUsage: Record<string, Usage>;
  modelUsage: Record<string, Usage>;
  providerUsage: Record<string, Usage>;
  providerModelUsage: Record<string, Record<string, Usage>>;
}

// 文件签名：mtime + size，任一变化即视为需重解析
function fileSig(fp: string): string | null {
  try {
    const st = statSync(fp);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

// 解析单个 jsonl 文件，返回该文件对应的会话聚合
function parseFile(fp: string, defaultId: string): FileAgg {
  let cwd = '';
  let sessionId = defaultId;
  let name = '';
  let startTs: string | null = null;
  let endTs: string | null = null;
  let messages = 0;
  const usage = emptyUsage();
  const dayUsage: Record<string, Usage> = {};
  const modelUsage: Record<string, Usage> = {};
  const providerUsage: Record<string, Usage> = {};
  const providerModelUsage: Record<string, Record<string, Usage>> = {};

  let lines: string[] = [];
  try {
    lines = readFileSync(fp, 'utf8').split('\n');
  } catch {
    return { id: sessionId, cwd: '(unknown)', name: sessionId.slice(0, 8), startTs, endTs, messages, usage, dayUsage, modelUsage, providerUsage, providerModelUsage };
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = e.timestamp as string | undefined;
    if (ts) {
      if (startTs === null) startTs = ts;
      endTs = ts;
    }
    if (e.type === 'session') {
      if (e.cwd) cwd = e.cwd;
      if (e.id) sessionId = e.id;
    }
    if (e.type === 'message') {
      const m = e.message;
      if (m && m.role === 'user' && !name) {
        name = firstText(m.content).replace(/\s+/g, ' ').trim();
      }
      if (m && m.role === 'assistant') {
        messages++;
        const model = m.model || 'unknown';
        const provider = m.provider || 'unknown';
        const mu = (modelUsage[model] ||= emptyUsage());
        const pu = (providerUsage[provider] ||= emptyUsage());
        addUsage(mu, getUsage(e));
        addUsage(pu, getUsage(e));
        const pmu = (providerModelUsage[provider] ||= {});
        const pmuM = (pmu[model] ||= emptyUsage());
        addUsage(pmuM, getUsage(e));
      }
    }
    const u = getUsage(e);
    if (u) {
      const date = shanghaiDate(ts);
      if (date) addUsage((dayUsage[date] ||= emptyUsage()), u);
      addUsage(usage, u);
    }
  }

  if (!name) name = sessionId.slice(0, 8);
  return { id: sessionId, cwd: cwd || '(unknown)', name: name.slice(0, 90), startTs, endTs, messages, usage, dayUsage, modelUsage, providerUsage, providerModelUsage };
}

// 文件级增量缓存：path -> { sig, agg }
const fileCache = new Map<string, { sig: string; agg: FileAgg }>();

export function scan(): ScanResult {
  const sessionsDir = resolveSessionsDir();
  const sessions: SessionAgg[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    console.error('无法读取会话目录:', sessionsDir, err);
    return { generatedAt: new Date().toISOString(), sessionsDir, sessions: [] };
  }

  const seen = new Set<string>();

  for (const dir of entries) {
    let files: string[] = [];
    try {
      files = readdirSync(join(sessionsDir, dir));
    } catch {
      continue;
    }
    for (const fn of files) {
      if (!fn.endsWith('.jsonl')) continue;
      const fp = join(sessionsDir, dir, fn);
      seen.add(fp);

      const defaultId = fn.includes('_')
        ? fn.split('_').slice(1).join('_').replace('.jsonl', '')
        : fn.replace('.jsonl', '');

      const sig = fileSig(fp);
      if (!sig) continue;
      const cached = fileCache.get(fp);
      let agg: FileAgg;
      if (cached && cached.sig === sig) {
        agg = cached.agg;
      } else {
        agg = parseFile(fp, defaultId);
        fileCache.set(fp, { sig, agg });
      }

      sessions.push({
        id: agg.id,
        cwd: agg.cwd,
        name: agg.name,
        startTs: agg.startTs,
        endTs: agg.endTs,
        messages: agg.messages,
        dayUsage: agg.dayUsage,
        modelUsage: agg.modelUsage,
        providerUsage: agg.providerUsage,
        providerModelUsage: agg.providerModelUsage,
        ...agg.usage,
      });
    }
  }

  // 清理已删除文件的缓存，避免内存无限增长
  for (const k of fileCache.keys()) {
    if (!seen.has(k)) fileCache.delete(k);
  }

  sessions.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
  return { generatedAt: new Date().toISOString(), sessionsDir, sessions };
}
