// 极简 HTTP 服务：托管 public/index.html，并提供 /api/data（每次请求都重新扫描磁盘，保证刷新即最新）。
import { scan } from './scan.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 15000;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
// 价格/货币持久化到磁盘（与浏览器、端口无关，重启不丢）
const PRICES_FILE = fileURLToPath(new URL('../prices.json', import.meta.url));

function loadPricesFile() {
  try {
    if (!existsSync(PRICES_FILE)) return null;
    const o = JSON.parse(readFileSync(PRICES_FILE, 'utf8'));
    return { prices: (o && o.prices) || {}, currency: (o && o.currency) || '¥' };
  } catch {
    return null;
  }
}
function savePricesFile(obj: { prices: Record<string, unknown>; currency: string }) {
  try {
    writeFileSync(PRICES_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 未找到');
    }
    return;
  }

  if (url.pathname === '/api/data') {
    const data = scan();
    const pc = loadPricesFile();
    data.prices = pc ? pc.prices : {};
    data.currency = pc ? pc.currency : '¥';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/prices') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const o = JSON.parse(body || '{}');
          const prices = (o && o.prices && typeof o.prices === 'object') ? o.prices : {};
          const currency = typeof o.currency === 'string' ? o.currency : '¥';
          savePricesFile({ prices, currency });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        }
      });
      return;
    }
    const pc = loadPricesFile() || { prices: {}, currency: '¥' };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(pc));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`pi-token-stats 已启动: http://localhost:${PORT}`);
  console.log(`会话目录: ${process.env.PI_SESSIONS_DIR || '~/.pi/agent/sessions'}`);
});
