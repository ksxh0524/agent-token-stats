// 极简 HTTP 服务：托管 public/ 静态文件，提供 /api/data（增量扫描 + 并发合并）与 /api/prices 配置接口。
// 加固点：
//  - POST body 上限 256KB；价格配置深度校验（有限非负数、键数量上限）
//  - prices.json 原子写（tmp + rename），并发写不损坏
//  - Origin/Host 校验，防恶意网页跨站写配置
//  - /api/data 结果 2s 内复用缓存，并发请求合并为一次扫描
import { scan } from './scan.ts';
import type { ApiData, ModelPrice, PriceConfig, ScanResult } from './types.ts';
import { syncPrices } from './prices-sync.ts';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT) || 32022;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PRICES_FILE = process.env.PRICES_FILE || fileURLToPath(new URL('../prices.json', import.meta.url));

const BODY_LIMIT = 256 * 1024;
const MAX_PRICE_KEYS = 5000;

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

  return { currency, rates, prices, modelAliases };
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
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('文件未找到');
  }
}

async function handlePrices(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const cfg = sanitizeConfig(parsed);
      await savePriceConfig(cfg);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad json' });
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
          await handlePrices(req, res);
          return;
        }
        if (p === '/api/prices/sync' && req.method === 'POST') {
          if (!isLocalTrusted(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden origin' });
            return;
          }
          try {
            sendJson(res, 200, { ok: true, ...(await syncPrices(await getPriceConfig(), savePriceConfig)) });
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
