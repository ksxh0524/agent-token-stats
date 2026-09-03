import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanOpencodeSessions } from '../src/opencode.ts';

// 构造最小可用的 opencode 数据库（只含本扫描器关心的列）
function makeFixtureDb(fp: string): void {
  const db = new DatabaseSync(fp);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare(`INSERT INTO session (id, directory, title) VALUES (?,?,?)`).run(
    'ses_aaa111',
    '/tmp/projA',
    'fix auth bug',
  );
  db.prepare(`INSERT INTO session (id, directory, title) VALUES (?,?,?)`).run(
    'ses_bbb222',
    '/tmp/projB',
    'empty session',
  );

  const msg = (id: string, sid: string, ms: number, data: Record<string, unknown>) =>
    db
      .prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`)
      .run(id, sid, ms, JSON.stringify(data));

  // 2026-08-20 10:00 北京时间
  const d1 = Date.UTC(2026, 7, 20, 2, 0, 0);
  // 2026-08-21 00:01 北京时间（跨天归到 21 日）
  const d2 = Date.UTC(2026, 7, 20, 16, 1, 0);

  msg('m1', 'ses_aaa111', d1, {
    role: 'assistant',
    modelID: 'deepseek-ai/DeepSeek-V4-Flash',
    providerID: 'siliconflow',
    cost: 0.2,
    tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 20, write: 3 }, total: 178 },
  });
  msg('m2', 'ses_aaa111', d2, {
    role: 'assistant',
    modelID: 'glm-5.2',
    providerID: 'zhipu',
    cost: 0.3,
    tokens: { input: 10, output: 8, reasoning: 0, cache: { read: 0, write: 0 }, total: 18 },
  });
  // 非 assistant / 无 tokens 的消息应被忽略
  msg('m3', 'ses_aaa111', d1, { role: 'user', text: 'hi' });
  db.close();
}

const dir = mkdtempSync(join(tmpdir(), 'oc-test-'));
const dbPath = join(dir, 'opencode.db');
makeFixtureDb(dbPath);
process.env.OPENCODE_DB = dbPath;

test.after?.(() => rmSync(dir, { recursive: true, force: true }));

test('opencode：聚合、按天、模型/提供商维度、source 标记', async () => {
  const r = await scanOpencodeSessions({ 'deepseek-ai/DeepSeek-V4-Flash': 'deepseek-v4-flash' });

  assert.equal(r.stat.enabled, true);
  assert.equal(r.sessions.length, 2); // 无 token 消息的会话也保留

  const a = r.sessions.find((s) => s.id === 'ses_aaa111')!;
  assert.ok(a);
  assert.equal(a.source, 'opencode');
  assert.equal(a.cwd, '/tmp/projA');
  assert.equal(a.name, 'fix auth bug');
  assert.equal(a.messages, 2);

  assert.equal(a.input, 110);
  assert.equal(a.output, 58);
  assert.equal(a.cacheRead, 20);
  assert.equal(a.cacheWrite, 3);
  assert.equal(a.reasoning, 5);
  assert.equal(a.totalTokens, 196);
  assert.equal(a.realCost, 0.5);

  // Asia/Shanghai 按天：d1 → 08-20，d2 → 08-21
  assert.deepEqual(Object.keys(a.dayUsage).sort(), ['2026-08-20', '2026-08-21']);
  assert.equal(a.dayUsage['2026-08-20'].input, 100);
  assert.equal(a.dayUsage['2026-08-21'].output, 8);

  // 别名映射生效；提供商维度保留原始模型名
  assert.deepEqual(Object.keys(a.modelUsage).sort(), ['deepseek-v4-flash', 'glm-5.2']);
  assert.equal(a.modelUsage['deepseek-v4-flash'].realCost, 0.2);
  assert.ok(a.providerModelUsage.siliconflow['deepseek-ai/DeepSeek-V4-Flash']);
  assert.equal(a.providerUsage.zhipu.input, 10);

  assert.ok(a.startTs && a.startTs.startsWith('2026-08-20T02:00')); // 10:00 +08 = 02:00Z
});

test('opencode：空会话保留为 0 用量、库不存在时禁用', async () => {
  const r = await scanOpencodeSessions();
  const b = r.sessions.find((s) => s.id === 'ses_bbb222')!;
  assert.ok(b);
  assert.equal(b.totalTokens, 0);
  assert.deepEqual(b.dayUsage, {});
});

test('opencode：库路径不存在时 enabled=false 且不抛错', async () => {
  process.env.OPENCODE_DB = join(dir, 'missing.db');
  const r = await scanOpencodeSessions();
  assert.equal(r.stat.enabled, false);
  assert.equal(r.sessions.length, 0);
});
