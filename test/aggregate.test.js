import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  addTo,
  emptyAgg,
  inWindow,
  sessionInWindow,
  sessionWindowUsage,
  enrichSession,
} from '../public/js/aggregate.js';

const P = { 'm-a': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };

function mkS(overrides = {}) {
  return {
    id: 's1',
    cwd: '/p',
    name: 'n',
    messages: 10,
    totalTokens: 200,
    input: 200,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    realCost: 0,
    dayUsage: {},
    modelUsage: {},
    modelDayUsage: {},
    providerUsage: {},
    providerModelUsage: {},
    ...overrides,
  };
}

test('inWindow 边界', () => {
  const win = { from: '2026-08-01', to: '2026-08-31' };
  assert.equal(inWindow('2026-08-01', win), true);
  assert.equal(inWindow('2026-08-31', win), true);
  assert.equal(inWindow('2026-07-31', win), false);
  assert.equal(inWindow('2026-09-01', win), false);
  assert.equal(inWindow('anything', null), true);
});

test('窗口严格过滤：窗口外会话不出现，token 只算窗口内天', () => {
  const sessions = [
    mkS({
      id: 'in',
      dayUsage: { '2026-08-10': { ...emptyAgg(), totalTokens: 100 }, '2026-07-01': { ...emptyAgg(), totalTokens: 999 } },
      modelDayUsage: { 'm-a': { '2026-08-10': { ...emptyAgg(), input: 100, totalTokens: 100 } } },
    }),
    mkS({ id: 'out', dayUsage: { '2026-06-01': { ...emptyAgg(), totalTokens: 500 } } }),
  ];
  const agg = aggregate({ sessions, prices: P, win: { from: '2026-08-01', to: '2026-08-31' } });
  assert.equal(agg.totals.sessions, 1); // out 被整体排除
  assert.equal(agg.totals.totalTokens, 100); // 窗口外的 999 不计
  assert.equal(agg.models.length, 1);
  assert.equal(agg.days.length, 1);
});

test('花费口径：真实优先，估算兜底；三视图一致', () => {
  const sessions = [
    mkS({
      dayUsage: {
        // 有真实费用
        '2026-08-10': { ...emptyAgg(), input: 1000, totalTokens: 1000, realCost: 5 },
        // 无真实费用 → 按 m-a 单价估：input×1/1e6
        '2026-08-11': { ...emptyAgg(), input: 2000, totalTokens: 2000 },
      },
      modelDayUsage: {
        'm-a': {
          '2026-08-10': { ...emptyAgg(), input: 1000, totalTokens: 1000, realCost: 5 },
          '2026-08-11': { ...emptyAgg(), input: 2000, totalTokens: 2000 },
        },
      },
    }),
  ];
  const agg = aggregate({ sessions, prices: P, win: null });
  assert.equal(agg.totals.realCost, 5);
  assert.equal(Math.abs(agg.totals.estCost - 0.002) < 1e-9, true);

  const modelSum = agg.models.reduce((a, m) => a + m.cost, 0);
  const wsSum = agg.workspaces.reduce((a, w) => a + w.cost, 0);
  assert.equal(Math.abs(modelSum - agg.totals.cost) < 1e-9, true);
  assert.equal(Math.abs(wsSum - agg.totals.cost) < 1e-9, true);
});

test('占比与消息折算', () => {
  const sessions = [
    mkS({ id: 'a', messages: 4, totalTokens: 300, dayUsage: { '2026-08-01': { ...emptyAgg(), totalTokens: 300 } } }),
    mkS({ id: 'b', messages: 6, totalTokens: 100, dayUsage: { '2026-08-02': { ...emptyAgg(), totalTokens: 100 } } }),
  ];
  const agg = aggregate({ sessions, prices: {}, win: null });
  assert.equal(agg.totals.totalTokens, 400);
  assert.equal(agg.totals.messages, 10);
  assert.ok(agg.models.every(() => true));
  const wsA = agg.workspaces[0];
  assert.equal(wsA.pct > 0 && wsA.pct <= 100, true);
});

test('enrichSession：命中率与主力模型按窗口内 token', () => {
  const s = mkS({
    totalTokens: 300,
    dayUsage: { '2026-08-05': { ...emptyAgg(), input: 50, cacheRead: 50, totalTokens: 100 } },
    modelDayUsage: {
      big: { '2026-08-05': { ...emptyAgg(), totalTokens: 80 } },
      small: { '2026-08-05': { ...emptyAgg(), totalTokens: 20 } },
    },
  });
  const e = enrichSession(s, {}, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(e.hitRate, 50);
  assert.equal(e.topModel, 'big');
  assert.equal(e.ratio, 1 / 3);
});

test('addTo / emptyAgg 基础', () => {
  const a = emptyAgg();
  addTo(a, { ...emptyAgg(), input: 3, realCost: 1.5 });
  assert.equal(a.input, 3);
  assert.equal(a.realCost, 1.5);
});

test('sessionInWindow / sessionWindowUsage', () => {
  const s = mkS({ dayUsage: { '2026-08-05': { ...emptyAgg(), output: 7 } } });
  assert.equal(sessionInWindow(s, { from: '2026-08-01', to: '' }), true);
  assert.equal(sessionInWindow(s, { from: '2026-09-01', to: '' }), false);
  assert.equal(sessionWindowUsage(s, null).output, 7);
});

// ---------- aggregateProviderModels：按服务商分组看模型 ----------
import { aggregateProviderModels } from '../public/js/aggregate.js';

test('aggregateProviderModels：分组、窗口过滤、blended 费用与占比', () => {
  const prices = { 'm-a': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const mk = (over = {}) => mkS({ providerUsage: {}, providerModelUsage: {}, ...over });
  const sessions = [
    mk({
      providerModelUsage: {
        'prov-A': { 'm-a': { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 100, realCost: 0.5 } },
        'prov-B': { 'm-b': { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 50, realCost: 0 } },
      },
      providerUsage: {
        'prov-A': { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 100, realCost: 0.5 },
        'prov-B': { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 50, realCost: 0 },
      },
      dayUsage: { '2026-08-10': { input: 150, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 150, realCost: 0.5 } },
    }),
    mk({
      id: 's2',
      dayUsage: { '2020-01-01': { input: 999, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 999, realCost: 0 } },
    }), // 窗口外，应被排除
  ];
  const win = { from: '2026-08-01', to: '2026-08-31' };
  const groups = aggregateProviderModels({ sessions, prices, win, aliases: {} });

  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.key === 'prov-A');
  const b = groups.find((g) => g.key === 'prov-B');
  assert.ok(a && b);
  // prov-A：realCost>0 → 用真实值；prov-B：无 realCost → 按单价估（m-b 无单价 → est=0）
  assert.ok(Math.abs(a.cost - 0.5) < 1e-9);
  assert.ok(a.estCost === 0);
  assert.equal(a.models.length, 1);
  assert.equal(a.models[0].key, 'm-a');
  assert.equal(b.models[0].key, 'm-b');
  // 占比：prov-A 100 / 150
  assert.ok(Math.abs(a.pct - (100 / 150) * 100) < 1e-6);
  // 排序：prov-A(100) > prov-B(50)
  assert.equal(groups[0].key, 'prov-A');
});

test('providers 消息数按 token 占比分摊，多服务商会话不重复计数', () => {
  const s = mkS({
    messages: 10,
    totalTokens: 300,
    dayUsage: { '2026-08-10': { ...emptyAgg(), totalTokens: 300 } },
    providerUsage: {
      'prov-A': { ...emptyAgg(), totalTokens: 200 },
      'prov-B': { ...emptyAgg(), totalTokens: 100 },
    },
    providerModelUsage: {
      'prov-A': { 'm-a': { ...emptyAgg(), totalTokens: 200 } },
      'prov-B': { 'm-b': { ...emptyAgg(), totalTokens: 100 } },
    },
  });
  const agg = aggregate({ sessions: [s], prices: {}, win: null });
  const a = agg.providers.find((p) => p.key === 'prov-A');
  const b = agg.providers.find((p) => p.key === 'prov-B');
  assert.ok(Math.abs(a.messages - 10 * (200 / 300)) < 1e-9);
  assert.ok(Math.abs(b.messages - 10 * (100 / 300)) < 1e-9);
  assert.ok(Math.abs(a.messages + b.messages - 10) < 1e-9); // 分摊后合计 = 会话消息数

  const groups = aggregateProviderModels({ sessions: [s], prices: {}, win: null, aliases: {} });
  const ga = groups.find((g) => g.key === 'prov-A');
  const gb = groups.find((g) => g.key === 'prov-B');
  assert.ok(Math.abs(ga.messages - 10 * (200 / 300)) < 1e-9);
  assert.ok(Math.abs(gb.messages - 10 * (100 / 300)) < 1e-9);
  assert.ok(Math.abs(ga.models[0].messages - 10 * (200 / 300)) < 1e-9); // 模型行与所属服务商行一致
});

test('按天视图：days 行携带花费，逐日合计 = 总花费', () => {
  const sessions = [
    mkS({
      dayUsage: {
        '2026-08-10': { ...emptyAgg(), input: 1000, totalTokens: 1000, realCost: 5 },
        '2026-08-11': { ...emptyAgg(), input: 2000, totalTokens: 2000 },
      },
      modelDayUsage: {
        'm-a': {
          '2026-08-10': { ...emptyAgg(), input: 1000, totalTokens: 1000, realCost: 5 },
          '2026-08-11': { ...emptyAgg(), input: 2000, totalTokens: 2000 },
        },
      },
    }),
  ];
  const agg = aggregate({ sessions, prices: P, win: null });
  assert.equal(agg.days.length, 2);
  const daySum = agg.days.reduce((a, d) => a + d.cost, 0);
  assert.ok(Math.abs(daySum - agg.totals.cost) < 1e-9); // 与总花费口径一致
  assert.ok(Math.abs(agg.days.reduce((a, d) => a + d.estCost, 0) - agg.totals.estCost) < 1e-9);
  // 实/估混合：8/10 实、8/11 估
  const d10 = agg.days.find((d) => d.key === '2026-08-10');
  const d11 = agg.days.find((d) => d.key === '2026-08-11');
  assert.ok(d10.realCost > 0 && d10.estCost === 0);
  assert.ok(d11.realCost === 0 && d11.estCost > 0);
});

test('enrichSession：est 只累计估算部分（供实/估角标判混合）', () => {
  const s = mkS({
    totalTokens: 3000,
    dayUsage: {
      '2026-08-10': { ...emptyAgg(), input: 1000, totalTokens: 1000, realCost: 5 },
      '2026-08-11': { ...emptyAgg(), input: 2000, totalTokens: 2000 },
    },
    modelDayUsage: {
      'm-a': {
        '2026-08-10': { ...emptyAgg(), input: 1000, totalTokens: 1000, realCost: 5 },
        '2026-08-11': { ...emptyAgg(), input: 2000, totalTokens: 2000 },
      },
    },
  });
  const e = enrichSession(s, P, null);
  assert.ok(Math.abs(e.real - 5) < 1e-9);
  assert.ok(Math.abs(e.est - 0.002) < 1e-9); // 只有 8/11 参与估算，8/10 的估算值不计入
  assert.ok(e.real > 0 && e.est > 0); // 混合口径 → 实+估
});
