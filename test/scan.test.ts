import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelName, scan } from '../src/scan.ts';

process.env.PI_SESSIONS_DIR = new URL('./fixtures', import.meta.url).pathname;
// 隔离 opencode 数据源：指向不存在的库，保证本测试只验证 pi 扫描
process.env.OPENCODE_DB = '/tmp/nonexistent-opencode-for-scan-test.db';
// 扫描库每次运行用独立路径：库里的会话是「只增不减」的归档数据，
// 复用旧库会让上一轮的结果混进来，断言会飘。
process.env.PI_SCAN_DB = `/tmp/agent-token-stats-test-store-${process.pid}-${Date.now()}.db`;

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
  // 数据源概况：pi 启用，opencode 因库不存在被禁用
  assert.equal(r.sources.pi.enabled, true);
  assert.equal(r.sources.pi.sessions, 2);
  assert.equal(r.sources.opencode.enabled, false);
  // pi 会话都带 source 标记
  assert.ok(r.sessions.every((s) => s.source === 'pi'));

  const a = r.sessions.find((s) => s.id === 'sid-a')!;
  assert.ok(a);
  // 名称取首条 user 消息并压平空白
  assert.equal(a.name, 'hello world');
  assert.equal(a.cwd, '/tmp/projA');
  assert.equal(a.messages, 2);

  // 总量 = assistant ×2 + compaction 顶层 usage + subagent results + 工具内调用；
  // totalTokens 缺失回退四项和
  assert.equal(a.input, 490); // 100+30+10+300+50
  assert.equal(a.output, 185); // 50+20+5+100+10
  assert.equal(a.cacheRead, 1020); // 20+1000
  assert.equal(a.cacheWrite, 5);
  assert.equal(a.reasoning, 10);
  assert.equal(a.totalTokens, 175 + 50 + 15 + 1400 + 60);
  assert.ok(Math.abs(a.realCost - 0.93) < 1e-9); // 0.5 + 0.42(subagent 裸数字 cost) + 0.01

  // 按天（npm test 固定 TZ=Asia/Shanghai）
  assert.equal(a.dayUsage['2026-08-20'].totalTokens, 175);
  assert.equal(a.dayUsage['2026-08-21'].totalTokens, 50); // 兜底 30+20
  assert.equal(a.dayUsage['2026-08-22'].totalTokens, 15);
  assert.equal(a.dayUsage['2026-08-23'].totalTokens, 1460); // subagent 1400 + 工具 60

  // 模型归一：org/ 前缀剥掉后同一模型合并
  const mu = a.modelUsage['deepseek-v4-flash'];
  assert.ok(mu);
  assert.equal(mu.input, 140); // 100+30+compaction 归因 10
  assert.equal(mu.totalTokens, 240); // 175+50+compaction 归因 15
  assert.equal(mu.realCost, 0.5);
  assert.equal(a.modelDayUsage['deepseek-v4-flash']['2026-08-21'].output, 20);
  // compaction 不带模型，归因到会话内最近一次 assistant 所用模型
  assert.equal(a.modelDayUsage['deepseek-v4-flash']['2026-08-22'].totalTokens, 15);

  // subagent：results[].usage 各自带模型，全零的那条被跳过
  assert.equal(a.modelUsage['gpt-5.6'].totalTokens, 1400);
  assert.equal(a.modelUsage['gpt-5.6'].input, 300);
  assert.equal(a.modelUsage['gpt-5.6'].realCost, 0.42);
  // 工具内 LLM 调用（toolResult 带 usage，模型在 details 里）
  assert.equal(a.modelUsage['glm-5.2'].totalTokens, 60);
  assert.equal(a.modelUsage['glm-5.2'].realCost, 0.01);
  assert.equal(Object.keys(a.modelUsage).length, 3);

  // 提供商维度：主会话归 siliconflow；subagent / 工具调用没给 provider，归 unknown
  assert.equal(a.providerUsage.siliconflow.totalTokens, 240);
  assert.equal(a.providerUsage.unknown.totalTokens, 1460);
  assert.ok(a.providerModelUsage.siliconflow['deepseek-ai/DeepSeek-V4-Flash']);
  assert.ok(a.providerModelUsage.unknown['openai/gpt-5.6']);

  // 别名映射生效
  const b = r.sessions.find((s) => s.id === 'sid-b')!;
  assert.deepEqual(Object.keys(b.modelUsage), ['glm-5.2']);
});
