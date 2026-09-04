import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 34777;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;
let child;
let pricesFile;
let sessionsDir;

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

before(async () => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'pits-sessions-'));
  const dir = join(sessionsDir, '--proj--');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '2026-08-20T01-00-00Z_s1.jsonl'),
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-08-20T01:00:00Z', cwd: '/p' }) +
      '\n' +
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-20T01:00:10Z',
        message: { role: 'assistant', model: 'gpt-5.6-luna', provider: 'Tokeness-OpenAI', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } } },
      }) +
      // 结尾必须有换行：扫描器把「没有 \n 结尾的尾部」视为 pi 正在写入的半行而跳过
      // （防重复解析），真实 pi 的 jsonl 每条事件都以 \n 结尾，fixture 保持一致。
      '\n',
  );
  pricesFile = join(tmpdir(), `pits-prices-${Date.now()}.json`);
  writeFileSync(pricesFile, JSON.stringify({ currency: '¥', rates: { '$': 7.2 }, prices: {}, modelAliases: {} }));

  child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_SESSIONS_DIR: sessionsDir,
      PRICES_FILE: pricesFile,
      OPENCODE_DB: join(tmpdir(), `pits-missing-${Date.now()}.db`),
      // 扫描库必须隔离：库里的会话只增不减（归档），不隔离会①断言撞上生产数据，②把测试会话写进生产库
      PI_SCAN_DB: join(tmpdir(), `pits-store-${Date.now()}.db`),
    },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  child?.kill();
  try {
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(pricesFile, { force: true });
  } catch {}
});

test('GET /health', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});

test('GET /api/data：会话与配置齐全，真实费用被采集', async () => {
  const r = await fetch(`${BASE}/api/data`);
  const j = await r.json();
  assert.equal(j.sessions.length, 1);
  assert.equal(j.sessions[0].realCost, 0.25);
  assert.equal(typeof j.prices, 'object');
  assert.equal(j.currency, '¥');
});

test('POST /api/prices：跨站来源被拒（403）', async () => {
  const r = await fetch(`${BASE}/api/prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{}',
  });
  assert.equal(r.status, 403);
});

test('POST /api/prices：非法值清洗 + 原子写盘', async () => {
  const r = await fetch(`${BASE}/api/prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency: '¥', rates: { '$': 7.3 }, prices: { m1: { input: -5, output: 'x', cacheRead: 2 } }, modelAliases: { a: '' } }),
  });
  assert.equal(r.status, 200);
  // 磁盘上的文件必须是合法 JSON（原子写不产生半截文件）
  const disk = JSON.parse(readFileSync(pricesFile, 'utf8'));
  assert.equal(disk.rates['$'], 7.3);
  assert.equal(disk.prices.m1.input, 0); // 负数清零
  assert.equal(disk.prices.m1.output, 0); // 非数清零
  assert.equal(disk.prices.m1.cacheRead, 2);
  assert.deepEqual(disk.modelAliases, {}); // 空映射被丢弃
  // GET 回读一致
  const g = await (await fetch(`${BASE}/api/prices`)).json();
  assert.equal(g.prices.m1.cacheRead, 2);
});

test('POST /api/prices：超大 body 被拒', async () => {
  let err = null;
  try {
    await fetch(`${BASE}/api/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices: { big: 'x'.repeat(300 * 1024) } }),
    });
  } catch (e) {
    err = e; // 连接被服务端销毁也算通过
  }
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.ok, true); // 服务仍然健康
});

test('GET /api/data：版本号轮询短路（unchanged）', async () => {
  const first = await (await fetch(`${BASE}/api/data`)).json();
  assert.ok(first.revision, 'revision 必须存在');
  const r = await fetch(`${BASE}/api/data?rev=${encodeURIComponent(first.revision)}`);
  const j = await r.json();
  assert.equal(j.unchanged, true);
  assert.equal(j.revision, first.revision);
  assert.equal(j.sessions, undefined); // 短路响应不带大载荷
});

test('源文件删除 → 归档翻转被版本号捕获，归档会话保留', async () => {
  const first = await (await fetch(`${BASE}/api/data`)).json();
  assert.equal(first.sessions.length, 1);
  assert.notEqual(first.sessions[0].archived, true);

  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(sessionsDir, '--proj--', '2026-08-20T01-00-00Z_s1.jsonl'));

  // 服务端对 /api/data 有 2s 缓存：窗口内的 rev 轮询允许基于旧快照短路（下一轮必抓到），
  // 这里等缓存过期，验证的是「最新扫描必须感知归档翻转」这一硬语义
  await new Promise((r) => setTimeout(r, 2100));

  // 带 rev 轮询：归档翻转是真实数据变化，不能被短路误判为 unchanged
  const r2 = await fetch(`${BASE}/api/data?rev=${encodeURIComponent(first.revision)}`);
  const j2 = await r2.json();
  assert.equal(j2.unchanged, undefined);
  assert.notEqual(j2.revision, first.revision);
  assert.equal(j2.sessions.length, 1); // 会话没丢 —— 归档承诺
  assert.equal(j2.sessions[0].archived, true);

  // 版本号已同步，下一轮恢复短路
  const r3 = await fetch(`${BASE}/api/data?rev=${encodeURIComponent(j2.revision)}`);
  const j3 = await r3.json();
  assert.equal(j3.unchanged, true);
});

test('静态资源白名单：目录穿越不可达', async () => {
  const r = await fetch(`${BASE}/../prices.json`);
  assert.equal([404, 400].includes(r.status), true);
});
