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
