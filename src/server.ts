// 极简 HTTP 服务：托管 public/ 静态文件，提供 /api/data（增量扫描 + 并发合并）与 /api/prices 配置接口。
// 加固点：
//  - POST body 上限 256KB；价格配置深度校验（有限非负数、键数量上限）
//  - prices.json 原子写（tmp + rename），并发写不损坏
//  - Origin/Host 校验，防恶意网页跨站写配置
//  - /api/data 结果 2s 内复用缓存，并发请求合并为一次扫描
import { scan } from './scan.ts';
import type { ApiData, ModelPrice, PriceConfig, PriceSource, ScanResult } from './types.ts';
import { syncPrices } from './prices-sync.ts';
import { fetchRates } from './rates.ts';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT) || 32022;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PRICES_FILE = process.env.PRICES_FILE || fileURLToPath(new URL('../prices.json', import.meta.url));

const BODY_LIMIT = 256 * 1024;
const MAX_PRICE_KEYS = 5000;

const PRICE_SOURCES = new Set<PriceSource>(['manual', 'pi', 'models.dev', 'github']);

// ---------- 价格配置 ----------
function sanitizePrice(v: unknown): ModelPrice {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const f = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e9 ? x : 0);
  return { input: f(o.input), output: f(o.output), cacheRead: f(o.cacheRead), cacheWrite: f(o.cacheWrite) };
}

export function sanitizeConfig(raw: unknown): PriceConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const currency = typeof o.currency === 'string' && o.currency.length <= 8 ? o.currency : '¥';

  const rates: Record<string, number> = {};
  if (o.rates && typeof o.rates === 'object') {
    for (const [k, v] of Object.entries(o.rates as Record<string, unknown>).slice(0, 64)) {
      if (typeof k === 'string' && k.length <= 8 && typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1e6) {
        rates[k] = v;
      }
    }
  }
  if (!Object.keys(rates).length) Object.assign(rates, { '$': 7.2, '€': 7.8, '£': 9.1, '₩': 0.0052 });

  const prices: Record<string, ModelPrice> = {};
  if (o.prices && typeof o.prices === 'object') {
    for (const [k, v] of Object.entries(o.prices as Record<string, unknown>).slice(0, MAX_PRICE_KEYS)) {
      if (!k || k.length > 200) continue;
      prices[k] = sanitizePrice(v);
    }
  }

  const modelAliases: Record<string, string> = {};
  if (o.modelAliases && typeof o.modelAliases === 'object') {
    for (const [k, v] of Object.entries(o.modelAliases as Record<string, unknown>).slice(0, MAX_PRICE_KEYS)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v && k.length <= 200 && v.length <= 200) {
        modelAliases[k] = v;
      }
    }
  }

  const priceSources: Record<string, PriceSource> = {};
  if (o.priceSources && typeof o.priceSources === 'object') {
    for (const [k, v] of Object.entries(o.priceSources as Record<string, unknown>).slice(0, MAX_PRICE_KEYS)) {
      if (typeof k === 'string' && k && k.length <= 200 && typeof v === 'string' && PRICE_SOURCES.has(v as PriceSource)) {
        priceSources[k] = v as PriceSource;
      }
    }
  }

  return { currency, rates, prices, modelAliases, priceSources };
}

let cfgCache: { mtimeMs: number; size: number; cfg: PriceConfig } | null = null;
async function statSafe(fp: string) {
  try {
    return await stat(fp);
  } catch {
    return null;
  }
}

async function getPriceConfig(): Promise<PriceConfig> {
  const st = await statSafe(PRICES_FILE);
  if (!st) return sanitizeConfig({});
  if (cfgCache && cfgCache.mtimeMs === st.mtimeMs && cfgCache.size === st.size) return cfgCache.cfg;
  try {
    const text = await readFile(PRICES_FILE, 'utf8');
    const cfg = sanitizeConfig(JSON.parse(text));
    cfgCache = { mtimeMs: st.mtimeMs, size: st.size, cfg };
    return cfg;
  } catch {
    return sanitizeConfig({});
  }
}

async function savePriceConfig(cfg: PriceConfig): Promise<void> {
  const tmp = `${PRICES_FILE}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2));
  await rename(tmp, PRICES_FILE);
  const st = await statSafe(PRICES_FILE);
  if (st) cfgCache = { mtimeMs: st.mtimeMs, size: st.size, cfg };
}


// ---------- 配置写串行化 ----------
// 价格同步与汇率更新都会「读 prices.json → 改一块 → 写回」，并发时会互相覆盖（后写的带上旧的一半）。
// 所有对配置的读改写都过这个队列，一次只跑一个。
let configQueue: Promise<unknown> = Promise.resolve();
function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = configQueue.then(fn, fn);
  configQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------- 价格自动同步 ----------
// 官方目录（models.dev）随时在加新模型，靠手点按钮会长期停在不全的状态。
// 启动后延迟跑一次 + 固定间隔重跑：只补「缺失 / 全 0」的 key，已有非 0 价（手填）永不覆盖。
const SYNC_ENABLED = process.env.PRICES_SYNC !== 'off';
const SYNC_INTERVAL_MS = Number(process.env.PRICES_SYNC_INTERVAL_MS) || 12 * 3600 * 1000;
const SYNC_DELAY_MS = Number(process.env.PRICES_SYNC_DELAY_MS) || 10_000;
let syncing = false;

// ---------- 汇率自动更新 ----------
// 界面只选显示币种，比例由服务端每天从免费汇率源拉一次写进配置。
const RATES_ENABLED = process.env.RATES_SYNC !== 'off';
const RATES_INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 24 * 3600 * 1000;
const RATES_DELAY_MS = Number(process.env.RATES_DELAY_MS) || 3_000;

const sameRates = (a: Record<string, number>, b: Record<string, number>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

async function refreshRates(reason: string): Promise<void> {
  const fetched = await fetchRates();
  if (!fetched) {
    console.warn('[rates] 汇率拉取失败，保留现有值');
    return;
  }
  await withConfigLock(async () => {
    const cfg = await getPriceConfig();
    const rates = { ...cfg.rates, ...fetched };
    if (sameRates(cfg.rates, rates)) {
      console.log(`[rates] ${reason}更新：无变化（$ ${rates.$} / € ${rates['€']} / £ ${rates['£']} / ₩ ${rates['₩']}）`);
      return;
    }
    await savePriceConfig({ ...cfg, rates });
    console.log(`[rates] ${reason}更新：$ ${rates.$} · € ${rates['€']} · £ ${rates['£']} · ₩ ${rates['₩']}（1 外币 = N ¥）`);
  });
}

/** 同步范围 = 本地实际用到的模型：prices.json 里已有的 key ∪ 所有会话（pi / opencode）出现过的模型名。
 *  绝不用官方目录的全集 —— 那会把七千多个用不上的模型灌进本地配置。 */
async function localModelScope(): Promise<Set<string>> {
  const cfg = await getPriceConfig();
  const scope = new Set<string>(Object.keys(cfg.prices));
  try {
    const data = await getApiData();
    for (const s of data.sessions) for (const m of Object.keys(s.modelUsage || {})) scope.add(m);
  } catch {
    /* 扫描失败就只用已有配置里的模型，不阻断同步 */
  }
  return scope;
}

async function autoSyncPrices(reason: string): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const t0 = Date.now();
    const only = await localModelScope();
    const r = await withConfigLock(async () => syncPrices(await getPriceConfig(), savePriceConfig, { only }));
    const cost = `${Date.now() - t0}ms`;
    const routed = r.routed.length ? ` · 变体归并 ${r.routed.length}（${r.routed.slice(0, 3).map((x) => `${x.variant}→${x.base}`).join('、')}${r.routed.length > 3 ? ' 等' : ''}）` : '';
    if (r.filled.length || r.routed.length) {
      console.log(
        `[prices] ${reason}同步 ${cost}：本地模型 ${r.inScope} 个 · 填入 ${r.filled.length}（新增 ${r.added} · 补零 ${r.filledZero} · 纠正 ${r.corrected}）· 保留手填 ${r.skipped.length}${routed}`,
      );
    } else {
      console.log(`[prices] ${reason}同步 ${cost}：无需变更（本地模型 ${r.inScope} 个）`);
    }
  } catch (err) {
    console.error('[prices] 自动同步失败：', err);
  } finally {
    syncing = false;
  }
}

// ---------- /api/data 缓存与请求合并 ----------
const DATA_FRESH_MS = 2000;
let dataCache: { at: number; value: ApiData } | null = null;
let pendingScan: Promise<ApiData> | null = null;

// 对外的数据版本号 = 落库版本(revision) + 价格配置指纹。
// 价格/汇率/别名变了即使扫描数据没变，前端也要拿到新载荷重算显示。
function clientRevision(result: ScanResult, pricesStat: { mtimeMs: number; size: number } | null): string {
  return `${result.revision}:${pricesStat ? `${pricesStat.mtimeMs}:${pricesStat.size}` : 'none'}`;
}

async function getApiData(): Promise<ApiData> {
  if (dataCache && Date.now() - dataCache.at < DATA_FRESH_MS) return dataCache.value;
  pendingScan ??= (async () => {
    try {
      const t0 = Date.now();
      const cfg = await getPriceConfig();
      const pricesStat = await statSafe(PRICES_FILE);
      const t1 = Date.now();
      const result = await scan(cfg.modelAliases);
      const t2 = Date.now();
      const value: ApiData = { ...result, ...cfg, revision: clientRevision(result, pricesStat) };
      dataCache = { at: Date.now(), value };
      console.log(
        `[scan] 总计 ${t2 - t0}ms（配置 ${t1 - t0}ms + 扫描 ${t2 - t1}ms） 会话 ${result.sessions.length} 全量重解析 ${result.scannedFiles} 落库版本 ${result.revision}`,
      );
      return value;
    } finally {
      pendingScan = null;
    }
  })();
  return pendingScan;
}

// ---------- HTTP 工具 ----------
function isLocalTrusted(req: IncomingMessage): boolean {
  const host = (req.headers.host || '').toLowerCase();
  const okHost = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
  const origin = req.headers.origin;
  if (!origin) return okHost;
  try {
    return okHost && new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 仅允许白名单形式的静态路径，杜绝目录穿越
function resolveStaticPath(pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html') return join(PUBLIC_DIR, 'index.html');
  if (/^\/style\.css$/.test(pathname)) return join(PUBLIC_DIR, 'style.css');
  const m = /^\/js\/[A-Za-z0-9_-]+\.js$/.exec(pathname);
  if (m) return join(PUBLIC_DIR, pathname.slice(1));
  return null;
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const fp = resolveStaticPath(pathname);
  if (!fp) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  try {
    const buf = await readFile(fp);
    const type = STATIC_TYPES[fp.slice(fp.lastIndexOf('.'))] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch (err) {
    // 不要把错误吞掉：500 的真正原因（EPERM / EMFILE / ENOENT…）必须落日志，
    // 否则前端只看到「文件未找到」，排查时完全瞎猜（2026-09-27 踩过）。
    const e = err as NodeJS.ErrnoException;
    console.error(`[static] 读取失败 ${fp} → ${e.code ?? ''} ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('文件未找到');
  }
}

/** 界面保存配置时，把「值被改过 / 新加」的模型标成 manual —— 自动同步以后不碰它们。
 *  历史数据没有来源记录，一律按 manual 保守处理（宁可不覆盖，也不动用户填过的值）。 */
function withManualSources(prev: PriceConfig, next: PriceConfig): PriceConfig {
  const priceSources: Record<string, PriceSource> = {};
  for (const [m, p] of Object.entries(next.prices)) {
    const before = prev.prices[m];
    const same =
      !!before &&
      before.input === p.input &&
      before.output === p.output &&
      before.cacheRead === p.cacheRead &&
      before.cacheWrite === p.cacheWrite;
    priceSources[m] = same ? (prev.priceSources?.[m] ?? 'manual') : 'manual';
  }
  return { ...next, priceSources };
}

async function handlePrices(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === 'POST') {
    if (!isLocalTrusted(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden origin' });
      return;
    }
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 413, { ok: false, error: 'body too large or aborted' });
      return;
    }
    try {
      const parsed = JSON.parse(body || '{}');
      await withConfigLock(async () => {
        const prev = await getPriceConfig();
        const cfg = sanitizeConfig(parsed);
        // 防呆：页面数据没就绪时保存会带空 prices，别让它把整份配置抹了。
        // 真正要清空走「清空」按钮 → ?allowEmpty=1。
        if (!Object.keys(cfg.prices).length && Object.keys(prev.prices).length && url.searchParams.get('allowEmpty') !== '1') {
          throw new Error('refuse-empty');
        }
        // 汇率由服务端维护（定时拉取），忽略界面回传的旧值
        await savePriceConfig(withManualSources(prev, { ...cfg, rates: prev.rates }));
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      if (msg === 'refuse-empty') sendJson(res, 409, { ok: false, error: '空价格配置被拒绝（未带 allowEmpty）' });
      else sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    return;
  }
  // GET
  sendJson(res, 200, await getPriceConfig());
}

const server = createServer((req, res) => {
  void (async (): Promise<void> => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`);
      const p = url.pathname;

      if (p === '/health') {
        sendJson(res, 200, { ok: true, uptime: process.uptime() });
        return;
      }

      if (p.startsWith('/api/')) {
        if (p === '/api/data') {
          const cur = await getApiData();
          // 增量轮询：客户端版本号没变就只回几百字节，不传几 MB 的会话大载荷
          const clientRev = url.searchParams.get('rev');
          if (clientRev && clientRev === cur.revision) {
            sendJson(res, 200, { unchanged: true, revision: cur.revision, generatedAt: cur.generatedAt });
            return;
          }
          sendJson(res, 200, cur);
          return;
        }
        if (p === '/api/prices') {
          await handlePrices(req, res, url);
          return;
        }
        if (p === '/api/prices/sync' && req.method === 'POST') {
          if (!isLocalTrusted(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden origin' });
            return;
          }
          const dryRun = url.searchParams.get('dryRun') === '1';
          try {
            const only = await localModelScope();
            const r = await withConfigLock(async () =>
              syncPrices(await getPriceConfig(), savePriceConfig, { dryRun, only }),
            );
            sendJson(res, 200, { ok: true, ...r });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err as Error)?.message || err) });
          }
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      await serveStatic(res, p);
    } catch (err) {
      console.error('请求处理异常:', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    }
  })();
});

server.listen(PORT, () => {
  console.log(`agent-token-stats 已启动: http://localhost:${PORT}`);
  console.log(`pi 会话目录: ${process.env.PI_SESSIONS_DIR || '~/.pi/agent/sessions'}`);
  console.log(`opencode 数据库: ${process.env.OPENCODE_DB || '~/.local/share/opencode/opencode.db'}`);
  // 启动预热：不等第一个请求才发现要扫描。用户打开页面时数据通常已就绪，
  // 即使没就绪，pendingScan 也会把请求合并到这次预热上，不会重复扫
  void getApiData().catch(() => {});

  // 价格自动同步：错开启动高峰，先让首屏数据出来再联网拉价
  if (SYNC_ENABLED) {
    setTimeout(() => void autoSyncPrices('启动'), SYNC_DELAY_MS).unref();
    setInterval(() => void autoSyncPrices('定时'), SYNC_INTERVAL_MS).unref();
    console.log(`价格自动同步: 开启（启动后 ${Math.round(SYNC_DELAY_MS / 1000)}s 首次，每 ${Math.round(SYNC_INTERVAL_MS / 3600000)}h 一次；PRICES_SYNC=off 可关）`);
  }
  // 汇率自动更新：界面不填比例，这里每天拉一次
  if (RATES_ENABLED) {
    setTimeout(() => void refreshRates('启动'), RATES_DELAY_MS).unref();
    setInterval(() => void refreshRates('定时'), RATES_INTERVAL_MS).unref();
    console.log(`汇率自动更新: 开启（启动后 ${Math.round(RATES_DELAY_MS / 1000)}s 首次，每 ${Math.round(RATES_INTERVAL_MS / 3600000)}h 一次；RATES_SYNC=off 可关）`);
  }
});

// 收到终止信号：先掐掉所有 keep-alive 连接，否则 server.close() 的回调
// 永远不会触发，进程会被 SIGTERM 卡成不死不活的残留（stop 之后看着像没停掉）。
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    const bail = setTimeout(() => process.exit(0), 800);
    bail.unref();
    try {
      server.closeAllConnections?.();
    } catch {
      /* 版本不支持就算了，下面还有兜底 */
    }
    server.close(() => process.exit(0));
  });
}
