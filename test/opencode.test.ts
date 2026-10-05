import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeAdapter } from '../src/sources/opencode.ts';
import { ScanStore } from '../src/store.ts';

// 构造最小可用的 opencode 数据库（只含本扫描器关心的列；
// time_created/time_updated 对齐真实 schema 的 NOT NULL 约定）
function makeFixtureDb(fp: string): void {
  const db = new DatabaseSync(fp);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare(`INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)`).run(
    'ses_aaa111',
    '/tmp/projA',
    'fix auth bug',
    Date.UTC(2026, 7, 20, 2, 0, 0), // 与首条消息同时刻
    Date.UTC(2026, 7, 20, 16, 1, 0), // 与末条消息同时刻
  );
  db.prepare(`INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)`).run(
    'ses_bbb222',
    '/tmp/projB',
    'empty session',
    Date.UTC(2026, 7, 20, 1, 0, 0),
    Date.UTC(2026, 7, 20, 1, 0, 0),
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

const store = new ScanStore(join(dir, 'store.db'));

test.after?.(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('opencode：聚合、按天、模型/提供商维度、source 标记', async () => {
  const r = await opencodeAdapter.scan(store, { 'deepseek-ai/DeepSeek-V4-Flash': 'deepseek-v4-flash' });

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

  // 按天（npm test 固定 TZ=Asia/Shanghai）：d1 → 08-20，d2 → 08-21（跨天用例）
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

test('opencode：空会话保留为 0 用量、签名未变时零扫描', async () => {
  // 第一轮已把 fixture 库的签名记下：签名不变 → 不碰源库，直接出库里的数据
  // 注意别名哈希参与签名，必须与上一轮完全一致才算"没变"
  const r = await opencodeAdapter.scan(store, { 'deepseek-ai/DeepSeek-V4-Flash': 'deepseek-v4-flash' });
  const b = r.sessions.find((s) => s.id === 'ses_bbb222')!;
  assert.ok(b);
  assert.equal(b.totalTokens, 0);
  assert.deepEqual(b.dayUsage, {});
  assert.equal(r.scannedUnits, 0); // 增量命中，本轮没有读源库
});

test('opencode：源库删除会话后，本地归档保留（核心承诺）', async () => {
  // 模拟 opencode 侧删掉一个会话
  const db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM session WHERE id = ?').run('ses_bbb222');
  db.close();
  utimesSync(dbPath, new Date(), new Date()); // 碰 mtime 确保签名变化

  const r = await opencodeAdapter.scan(store, {});
  assert.equal(r.stat.enabled, true);
  // 源里只剩 1 个会话，但库里归档的 ses_bbb222 依然要返回 —— 历史不随源删除
  assert.equal(r.sessions.length, 2);
  assert.ok(r.sessions.find((s) => s.id === 'ses_bbb222'), '被删会话应作为归档保留');
  assert.ok(r.sessions.find((s) => s.id === 'ses_aaa111'));
});

test('opencode：库路径不存在时 enabled=false 且归档数据仍返回', async () => {
  process.env.OPENCODE_DB = join(dir, 'missing.db');
  const r = await opencodeAdapter.scan(store);
  assert.equal(r.stat.enabled, false);
  // 库没了 ≠ 历史没了：前几轮入库的会话照常展示
  assert.equal(r.sessions.length, 2);
});

// ---------------------------------------------------------------------------
// v2 schema（opencode >= 2.0.22）：会话/消息搬进 session_v2 / session_message。
// 2026-09-29 迁移当天老表就停止写入，只读老表的表现是「一切正常但漏掉迁移后全部
// 会话」—— 这个用例就是为了钉死那条回归。
// ---------------------------------------------------------------------------
function makeV2FixtureDb(fp: string): void {
  const db = new DatabaseSync(fp);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare(`INSERT INTO session_v2 (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)`).run(
    'ses_v2aaa',
    '/tmp/projA',
    'fix auth bug',
    Date.UTC(2026, 7, 20, 2, 0, 0),
    Date.UTC(2026, 7, 20, 16, 1, 0),
  );
  db.prepare(`INSERT INTO session_v2 (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)`).run(
    'ses_v2bbb',
    '/tmp/projB',
    'empty session',
    Date.UTC(2026, 7, 20, 1, 0, 0),
    Date.UTC(2026, 7, 20, 1, 0, 0),
  );

  const msg = (id: string, sid: string, type: string, ms: number, data: Record<string, unknown>) =>
    db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)`).run(
      id,
      sid,
      type,
      ms,
      JSON.stringify(data),
    );

  const d1 = Date.UTC(2026, 7, 20, 2, 0, 0);
  const d2 = Date.UTC(2026, 7, 20, 16, 1, 0);

  // variant 是 $.model.variant 的独立字段，不拼进 id —— 与老库 modelID 对齐
  msg('v1', 'ses_v2aaa', 'assistant', d1, {
    model: { id: 'deepseek-ai/DeepSeek-V4-Flash', providerID: 'siliconflow', variant: 'thinking' },
    cost: 0.2,
    tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 20, write: 3 } },
  });
  msg('v2', 'ses_v2aaa', 'assistant', d2, {
    model: { id: 'glm-5.2', providerID: 'zhipu' },
    cost: 0.3,
    tokens: { input: 10, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  // 非 assistant / 无 tokens 的消息应被忽略
  msg('v3', 'ses_v2aaa', 'user', d1, { text: 'hi' });
  db.close();
}

test('opencode：仅有 v2 表的库必须能扫出会话（迁移回归）', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'oc-v2-'));
  const dbPath2 = join(dir2, 'opencode.db');
  makeV2FixtureDb(dbPath2);
  process.env.OPENCODE_DB = dbPath2;
  const store2 = new ScanStore(join(dir2, 'store.db'));

  try {
    const r = await opencodeAdapter.scan(store2, { 'deepseek-ai/DeepSeek-V4-Flash': 'deepseek-v4-flash' });

    assert.equal(r.stat.enabled, true);
    assert.equal(r.sessions.length, 2, 'v2 会话必须被扫到');

    const a = r.sessions.find((s) => s.id === 'ses_v2aaa')!;
    assert.ok(a);
    assert.equal(a.source, 'opencode');
    assert.equal(a.cwd, '/tmp/projA');
    assert.equal(a.messages, 2);
    assert.equal(a.input, 110);
    assert.equal(a.output, 58);
    assert.equal(a.reasoning, 5);
    assert.equal(a.cacheRead, 20);
    assert.equal(a.cacheWrite, 3);
    assert.equal(a.totalTokens, 196);
    assert.equal(a.realCost, 0.5);

    assert.deepEqual(Object.keys(a.dayUsage).sort(), ['2026-08-20', '2026-08-21']);
    // variant 不进模型名，别名映射照常生效
    assert.deepEqual(Object.keys(a.modelUsage).sort(), ['deepseek-v4-flash', 'glm-5.2']);
    assert.ok(a.providerModelUsage.siliconflow['deepseek-ai/DeepSeek-V4-Flash']);
    assert.equal(a.providerUsage.zhipu.input, 10);

    // 无 token 的会话保留为 0 用量
    const b = r.sessions.find((s) => s.id === 'ses_v2bbb')!;
    assert.ok(b);
    assert.equal(b.totalTokens, 0);
  } finally {
    store2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v2 增量扫描：db 签名每轮都变（opencode 在跑）时，不能全量重扫、也不能每轮
// 空转 bump data_revision —— 否则前端 ?rev= 增量轮询永远拿不到空载荷。
// ---------------------------------------------------------------------------
const T0 = Date.UTC(2026, 7, 20, 2, 0, 0);

function makeIncFixture(fp: string): void {
  const db = new DatabaseSync(fp);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX session_message_time_created_idx ON session_message (time_created);
  `);
  for (const [id, dir] of [
    ['ses_i1', '/tmp/p1'],
    ['ses_i2', '/tmp/p2'],
    ['ses_i3', '/tmp/p3'],
  ] as const) {
    db.prepare(`INSERT INTO session_v2 (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)`).run(
      id,
      dir,
      `sess ${id}`,
      T0,
      T0,
    );
    db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)`).run(
      `m_${id}_1`,
      id,
      'assistant',
      T0,
      JSON.stringify({
        model: { id: 'mdl-a', providerID: 'prov' },
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
  }
  db.close();
}

function addMsg(fp: string, sid: string, ms: number, input: number): void {
  const db = new DatabaseSync(fp);
  db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)`).run(
    `m_${sid}_${ms}`,
    sid,
    'assistant',
    ms,
    JSON.stringify({
      model: { id: 'mdl-a', providerID: 'prov' },
      cost: 0,
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );
  db.close();
}

test('opencode v2：无新消息时不落库（data_revision 不空转）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'oc-inc-'));
  const fp = join(d, 'opencode.db');
  makeIncFixture(fp);
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    const first = await opencodeAdapter.scan(st, {});
    assert.equal(first.sessions.length, 3);
    const rev1 = st.getRevision();

    // 水位回退窗口会把旧消息重新扫到（幂等），但 per-session mtc 相等 → 不 upsert
    utimesSync(fp, new Date(), new Date());
    const second = await opencodeAdapter.scan(st, {});
    assert.equal(second.scannedUnits, 0, '没有新消息就不该有任何落库');
    assert.equal(st.getRevision(), rev1, 'data_revision 必须保持不变');
    assert.equal(second.sessions.length, 3);

    // 真的有新消息 → 只有那个会话的聚合变，其余原样
    addMsg(fp, 'ses_i1', T0 + 10 * 60 * 1000, 777);
    utimesSync(fp, new Date(), new Date());
    const third = await opencodeAdapter.scan(st, {});
    assert.ok(st.getRevision() > rev1, '有新消息必须 bump revision');

    const a = third.sessions.find((s) => s.id === 'ses_i1')!;
    const b = third.sessions.find((s) => s.id === 'ses_i2')!;
    const c = third.sessions.find((s) => s.id === 'ses_i3')!;
    assert.equal(a.input, 787, 'ses_i1 应加上新消息的 777');
    assert.equal(b.input, 10, 'ses_i2 不该被动到');
    assert.equal(c.input, 10, 'ses_i3 不该被动到');
    assert.equal(b.totalTokens, 15);
    assert.equal(c.totalTokens, 15);
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('opencode v2：session 元信息（title）变了要跟着更新', async () => {
  const d = mkdtempSync(join(tmpdir(), 'oc-inc2-'));
  const fp = join(d, 'opencode.db');
  makeIncFixture(fp);
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    await opencodeAdapter.scan(st, {});
    const before = st.getRevision();

    const db = new DatabaseSync(fp);
    db.prepare(`UPDATE session_v2 SET title = ? WHERE id = ?`).run('renamed by opencode', 'ses_i2');
    db.close();
    utimesSync(fp, new Date(), new Date());

    const r = await opencodeAdapter.scan(st, {});
    assert.equal(r.sessions.find((s) => s.id === 'ses_i2')!.name, 'renamed by opencode');
    assert.ok(st.getRevision() > before);
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('opencode v2：归档行不会每轮重复落库（否则 revision 永不停）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'oc-inc3-'));
  const fp = join(d, 'opencode.db');
  makeIncFixture(fp);
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    await opencodeAdapter.scan(st, {});

    // 源侧删掉一个会话 → 归档
    const db = new DatabaseSync(fp);
    db.prepare(`DELETE FROM session_v2 WHERE id = ?`).run('ses_i3');
    db.prepare(`DELETE FROM session_message WHERE session_id = ?`).run('ses_i3');
    db.close();
    utimesSync(fp, new Date(), new Date());
    const archived = await opencodeAdapter.scan(st, {});
    assert.ok(archived.sessions.find((s) => s.id === 'ses_i3'), '被删会话应作为归档保留');
    const rev = st.getRevision();

    // 之后每轮签名都变（opencode 在跑），归档行不得再引起落库
    for (let i = 0; i < 3; i++) {
      utimesSync(fp, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
      const r = await opencodeAdapter.scan(st, {});
      assert.equal(r.scannedUnits, 0, `第 ${i + 1} 轮不该有落库`);
      assert.equal(st.getRevision(), rev, `第 ${i + 1} 轮 revision 不该变`);
      assert.ok(r.sessions.find((s) => s.id === 'ses_i3'), '归档必须一直保留');
    }
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('opencode v2：compaction 消息的用量必须计入', async () => {
  const d = mkdtempSync(join(tmpdir(), 'oc-comp-'));
  const fp = join(d, 'opencode.db');
  makeIncFixture(fp);
  const db = new DatabaseSync(fp);
  db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)`).run(
    'm_compact',
    'ses_i1',
    'compaction',
    T0 + 1000,
    JSON.stringify({
      model: { id: 'mdl-a', providerID: 'prov' },
      cost: 0,
      tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 999, write: 0 } },
    }),
  );
  db.close();
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    const r = await opencodeAdapter.scan(st, {});
    const a = r.sessions.find((s) => s.id === 'ses_i1')!;
    assert.equal(a.input, 17, 'compaction 的 input 应计入');
    assert.equal(a.cacheRead, 999, 'compaction 的 cacheRead 应计入');
    assert.equal(a.totalTokens, 10 + 7 + 5 + 3 + 999);
    assert.ok(a.modelUsage['mdl-a'], 'compaction 也应进模型维度');
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('opencode v2：没变化的会话绝不能被误标成归档', async () => {
  // 回归：增量的 built 只含「动过的会话」，曾用 built.has(sid) 当归档判据，
  // 结果每轮都把所有没变化的会话标成 archived（真实库上一轮就中招了）。
  const d = mkdtempSync(join(tmpdir(), 'oc-noarch-'));
  const fp = join(d, 'opencode.db');
  makeIncFixture(fp);
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    await opencodeAdapter.scan(st, {});
    // 让水位落在很靠前，使后续几轮 touched 覆盖全部会话（强制走重建分支）
    for (let i = 0; i < 3; i++) {
      utimesSync(fp, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
      const r = await opencodeAdapter.scan(st, {});
      const live = r.sessions.filter((s) => !s.archived).map((s) => s.id).sort();
      assert.deepEqual(live, ['ses_i1', 'ses_i2', 'ses_i3'], `第 ${i + 1} 轮不该有任何会话被标归档`);
      assert.equal(r.sessions.length, 3);
    }
    // 数据也必须完好
    const last = await opencodeAdapter.scan(st, {});
    assert.equal(last.sessions.find((s) => s.id === 'ses_i2')!.input, 10);
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('opencode v2：源里还在的会话会被解除归档（自愈）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'oc-unarch-'));
  const fp = join(d, 'opencode.db');
  makeIncFixture(fp);
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    await opencodeAdapter.scan(st, {});
    // 人为把一个还在源里的会话标成归档（模拟上一轮误标 / opencode 恢复会话）
    st.setArchived('opencode', [{ unit: `${fp}#ses_i2`, archived: true }]);
    utimesSync(fp, new Date(), new Date());

    const r = await opencodeAdapter.scan(st, {});
    const live = r.sessions.filter((s) => !s.archived).map((s) => s.id).sort();
    assert.deepEqual(live, ['ses_i1', 'ses_i2', 'ses_i3'], '源里还在的会话必须解除归档');
    assert.equal(r.sessions.find((s) => s.id === 'ses_i2')!.input, 10, '数据不能丢');
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('opencode v2：老表里 v2 丢掉的迁移消息要按 id 去重补回来', async () => {
  // opencode 迁移到 v2 时给部分老会话各丢了 1 条 assistant 消息，但那些消息还在老表里，
  // 且两套表共用同一套 message id。补齐必须按 id 去重（不能把 5 万条重复计一遍），
  // 也必须在增量路径上补（否则会话拿到新消息后总量反而变小）。
  const d = mkdtempSync(join(tmpdir(), 'oc-recon-'));
  const fp = join(d, 'opencode.db');
  const T0 = Date.UTC(2026, 7, 20, 2, 0, 0);
  const db = new DatabaseSync(fp);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX session_message_time_created_idx ON session_message (time_created);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
  `);
  db.prepare(`INSERT INTO session_v2 VALUES (?,?,?,?,?)`).run('ses_r1', '/tmp/r', 'r', T0, T0);
  // 老表靠 data 里的 role 字段识别 assistant（v2 靠独立的 type 列）
  const asst = (model: string) => ({
    role: 'assistant',
    modelID: model,
    providerID: 'prov',
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  // 同一条消息同时存在于两套表 → 只能算一次
  db.prepare(`INSERT INTO session_message VALUES (?,?,?,?,?)`).run('msg_dup', 'ses_r1', 'assistant', T0, JSON.stringify(asst('m-a')));
  db.prepare(`INSERT INTO message VALUES (?,?,?,?)`).run('msg_dup', 'ses_r1', T0, JSON.stringify(asst('m-a')));
  // 只在老表里（模拟迁移丢失的那条）→ 必须补进来
  db.prepare(`INSERT INTO message VALUES (?,?,?,?)`).run(
    'msg_only_legacy',
    'ses_r1',
    T0 + 1000,
    JSON.stringify({ role: 'assistant', modelID: 'm-a', providerID: 'prov', cost: 0, tokens: { input: 777, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  );
  db.close();
  process.env.OPENCODE_DB = fp;
  const st = new ScanStore(join(d, 'store.db'));

  try {
    const r = await opencodeAdapter.scan(st, {});
    const a = r.sessions.find((s) => s.id === 'ses_r1')!;
    assert.equal(a.input, 787, '10（去重后）+ 777（老表补齐）');
    assert.equal(a.messages, 2, '重复的那条不能算两次');
    assert.equal(a.totalTokens, 787 + 5);

    // 增量路径：会话拿到新消息后，老表补齐的那部分不能丢
    addMsg(fp, 'ses_r1', T0 + 10 * 60 * 1000, 100);
    utimesSync(fp, new Date(), new Date());
    const r2 = await opencodeAdapter.scan(st, {});
    const b = r2.sessions.find((s) => s.id === 'ses_r1')!;
    assert.equal(b.input, 887, '增量重建也必须含老表补齐的 777');
    assert.ok(!b.archived);
  } finally {
    st.close();
    rmSync(d, { recursive: true, force: true });
  }
});
