// 聚合管线（纯函数，无 DOM 依赖，可被 node:test 直接测试）。
//
// 口径约定（所有维度统一）：
//  - 时间窗口 win = {from, to}（YYYY-MM-DD，空串表示不限）
//  - 窗口内没有任一天用量的会话整体排除 —— 模型 / 工作区 / 天 / 会话各视图一致
//  - token 类只累计窗口内天数；真实费用 realCost 按天精确累计
//  - 花费在「模型 × 天」粒度上取值：该格 realCost>0 用真实值（实），否则按单价估算（估）
//  - messages 按 token 占比折算到窗口
//  - providers 维度数据源未按天拆分，采用「窗口内活跃会话的全量数据」，UI 需标注口径

export function emptyAgg() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, realCost: 0 };
}

const AGG_KEYS = Object.keys(emptyAgg());

export function addTo(a, b) {
  for (const k of AGG_KEYS) a[k] += b[k] || 0;
}

export function inWindow(date, win) {
  if (!win || (!win.from && !win.to)) return true;
  if (win.from && date < win.from) return false;
  if (win.to && date > win.to) return false;
  return true;
}

export function zeroPrice() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// 单价：每百万 token 的 ¥ 价
export function estCost(u, price) {
  const p = price || zeroPrice();
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

// 真实优先，估算兜底（模型×天粒度）
export function blended(u, price) {
  return u.realCost > 0 ? u.realCost : estCost(u, price);
}

function normModel(name, aliases = {}) {
  let n = String(name || '').trim();
  if (!n) return 'unknown';
  if (aliases[n]) return aliases[n];
  const i = n.indexOf('/');
  if (i > 0 && i < n.length - 1) {
    const tail = n.slice(i + 1).toLowerCase();
    if (!['free', 'latest', 'default', 'chat', 'pro'].includes(tail)) n = n.slice(i + 1);
  }
  return n.replace(/:/g, '-').trim().toLowerCase() || 'unknown';
}

// 会话在窗口内的逐日用量汇总（token 类；不含花费）
export function sessionWindowUsage(s, win) {
  const u = emptyAgg();
  for (const [d, x] of Object.entries(s.dayUsage || {})) {
    if (inWindow(d, win)) addTo(u, x);
  }
  return u;
}

// 会话是否在窗口内有用量
export function sessionInWindow(s, win) {
  if (!win || (!win.from && !win.to)) return true;
  for (const d of Object.keys(s.dayUsage || {})) if (inWindow(d, win)) return true;
  return false;
}

function row(key) {
  return { key, sessions: 0, messages: 0, ...emptyAgg(), estCost: 0, cost: 0 };
}
function bumpRow(map, key) {
  let r = map.get(key);
  if (!r) map.set(key, (r = row(key)));
  return r;
}

/**
 * 主聚合入口。
 * @param sessions SessionAgg[]
 * @param prices Record<model, price>（归一化模型名 → 每百万单价）
 * @param win {from,to}
 * @returns { totals, workspaces, models, days, providers }
 */
export function aggregate({ sessions, prices = {}, win = null, aliases = {} }) {
  const totals = { ...row('TOTAL') };
  const wsMap = new Map();
  const modelMap = new Map();
  const dayMap = new Map();
  const provMap = new Map();

  for (const s of sessions) {
    if (!sessionInWindow(s, win)) continue;

    const wu = sessionWindowUsage(s, win);
    const fullTotal = Math.max(1, s.totalTokens || 0);
    const ratio = Math.min(1, wu.totalTokens / fullTotal);
    const wMsgs = (s.messages || 0) * ratio;

    // ---- 模型 × 天：花费与模型行（唯一花费口径）----
    const dayCostAcc = new Map(); // d -> {real, est, cost}
    let sessionBlended = 0;
    let sessionEst = 0;
    for (const [m, days] of Object.entries(s.modelDayUsage || {})) {
      const price = prices[m];
      let mu = null;
      for (const [d, u] of Object.entries(days)) {
        if (!inWindow(d, win)) continue;
        if (!mu) {
          mu = bumpRow(modelMap, m);
          mu.sessions++;
        }
        addTo(mu, u);
        const useReal = u.realCost > 0;
        const e = estCost(u, price);
        const c = useReal ? u.realCost : e;
        mu.estCost += useReal ? 0 : e; // est 只累计实际参与合计的部分，保证 实+估=总
        mu.cost += c;
        sessionEst += useReal ? 0 : e;
        sessionBlended += c;
        let dc = dayCostAcc.get(d);
        if (!dc) dayCostAcc.set(d, (dc = { real: 0, est: 0, cost: 0 }));
        dc.real += useReal ? u.realCost : 0;
        dc.est += useReal ? 0 : e;
        dc.cost += c;
      }
    }

    // ---- 总量 / 工作区 / 天 ----
    totals.sessions++;
    totals.messages += wMsgs;
    addTo(totals, wu);
    totals.estCost += sessionEst;
    totals.cost += sessionBlended;

    const w = bumpRow(wsMap, s.cwd);
    w.sessions++;
    w.messages += wMsgs;
    addTo(w, wu);
    w.cost += sessionBlended;
    w.estCost += sessionEst;

    for (const [d, x] of Object.entries(s.dayUsage || {})) {
      if (!inWindow(d, win)) continue;
      const dr = bumpRow(dayMap, d);
      dr.sessions++;
      addTo(dr, x);
      dr.messages += wMsgs / Math.max(1, Object.keys(s.dayUsage).length); // 近似折算到天
      const dc = dayCostAcc.get(d);
      if (dc) {
        dr.cost += dc.cost;
        dr.estCost += dc.est;
      }
    }

    // ---- 提供商：窗口内活跃会话的全量口径 ----
    for (const [p, rawModels] of Object.entries(s.providerModelUsage || {})) {
      const pr = bumpRow(provMap, p);
      pr.sessions++;
      pr.messages += s.messages || 0;
      const top = s.providerUsage?.[p];
      if (top) addTo(pr, top);
      for (const [raw, u] of Object.entries(rawModels)) {
        pr.cost += blended(u, prices[normModel(raw, aliases)]);
      }
    }
  }

  for (const r of modelMap.values()) r.pct = totals.totalTokens > 0 ? (r.totalTokens / totals.totalTokens) * 100 : 0;
  totals.pct = 100;
  for (const r of wsMap.values()) r.pct = totals.totalTokens > 0 ? (r.totalTokens / totals.totalTokens) * 100 : 0;
  for (const r of provMap.values()) r.pct = totals.totalTokens > 0 ? (r.totalTokens / totals.totalTokens) * 100 : 0;

  const toArr = (m) => [...m.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    totals,
    workspaces: toArr(wsMap),
    models: toArr(modelMap),
    days: toArr(dayMap).sort((a, b) => a.key.localeCompare(b.key)),
    providers: toArr(provMap),
  };
}

// 会话明细行的富化数据（窗口内口径），供排序与渲染
export function enrichSession(s, prices, win) {
  const wu = sessionWindowUsage(s, win);
  const denom = wu.cacheRead + wu.input;
  let cost = 0;
  let est = 0;
  let real = 0;
  let topModel = '-';
  let max = -1;
  for (const [m, days] of Object.entries(s.modelDayUsage || {})) {
    const price = prices[m];
    let mtokens = 0;
    for (const [d, u] of Object.entries(days)) {
      if (!inWindow(d, win)) continue;
      mtokens += u.totalTokens || 0;
      const e = estCost(u, price);
      est += e;
      real += u.realCost || 0;
      cost += u.realCost > 0 ? u.realCost : e;
    }
    if (mtokens > max) {
      max = mtokens;
      topModel = m;
    }
  }
  const hr = denom > 0 ? (wu.cacheRead / denom) * 100 : 0;
  const ratio = Math.min(1, wu.totalTokens / Math.max(1, s.totalTokens || 0));
  return { s, wu, hitRate: hr, cost, est, real, topModel, ratio };
}
