import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelName, scan } from '../src/scan.ts';

process.env.PI_SESSIONS_DIR = new URL('./fixtures', import.meta.url).pathname;

test('normalizeModelName：规则与映射', () => {
  const aliases = { 'weird-name': 'glm-5.2' };
  assert.equal(normalizeModelName('deepseek-ai/DeepSeek-V4-Flash'), 'deepseek-v4-flash');
  assert.equal(normalizeModelName('nvidia/nemotron-3-ultra-550b-a55b:free'), 'nemotron-3-ultra-550b-a55b-free');
  // 泛词末段不剥离，避免碰撞
  assert.equal(normalizeModelName('tokeness/free'), 'tokeness/free');
  // 映射表优先
  assert.equal(normalizeModelName('weird-name', aliases), 'glm-5.2');
  assert.equal(normalizeModelName(''), 'unknown');
});

test('scan()：聚合、归一、坏行统计、totalTokens 兜底', async () => {
  const r = await scan({ 'weird-name': 'glm-5.2' });

  assert.equal(r.sessions.length, 2);
  assert.equal(r.skippedLines, 1);
  assert.equal(r.scannedFiles >= 2, true);

  const a = r.sessions.find((s) => s.id === 'sid-a')!;
  assert.ok(a);
  // 名称取首条 user 消息并压平空白
  assert.equal(a.name, 'hello world');
  assert.equal(a.cwd, '/tmp/projA');
  assert.equal(a.messages, 2);

  // 总量 = assistant 消息 ×2 + compaction 顶层 usage；totalTokens 缺失回退四项和
  assert.equal(a.input, 140);
  assert.equal(a.output, 75);
  assert.equal(a.cacheRead, 20);
  assert.equal(a.cacheWrite, 5);
  assert.equal(a.reasoning, 10);
  assert.equal(a.totalTokens, 175 + 50 + 15);
  assert.equal(a.realCost, 0.5);

  // 按天（Asia/Shanghai）
  assert.equal(a.dayUsage['2026-08-20'].totalTokens, 175);
  assert.equal(a.dayUsage['2026-08-21'].totalTokens, 50); // 兜底 30+20
  assert.equal(a.dayUsage['2026-08-22'].totalTokens, 15);

  // 模型归一：org/ 前缀剥掉后同一模型合并
  const mu = a.modelUsage['deepseek-v4-flash'];
  assert.ok(mu);
  assert.equal(mu.input, 130);
  assert.equal(mu.totalTokens, 225);
  assert.equal(mu.realCost, 0.5);
  assert.equal(a.modelDayUsage['deepseek-v4-flash']['2026-08-21'].output, 20);

  // 提供商维度保留原始模型名键
  assert.equal(a.providerUsage.siliconflow.totalTokens, 225);
  assert.ok(a.providerModelUsage.siliconflow['deepseek-ai/DeepSeek-V4-Flash']);

  // 别名映射生效
  const b = r.sessions.find((s) => s.id === 'sid-b')!;
  assert.deepEqual(Object.keys(b.modelUsage), ['glm-5.2']);
});
