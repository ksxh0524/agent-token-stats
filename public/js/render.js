// 渲染层：只读 state，把聚合结果画到 DOM。所有表格排序键都基于富化后的数值字段。
import { fmt, fmtFull, esc, money, fmtDateTime, fmtDuration, fmtDay } from './format.js';

export function moneyFmt(state) {
  const rate = state.currency === '¥' ? 1 : state.data?.rates?.[state.currency] || 1;
  return (cny) => money(cny, state.currency, rate);
}

// 实/估角标：按窗口内「模型×天」单元格的混合口径标注（实+估 = 部分天有真实费用、其余按单价估算）
function costTag(real, est) {
  if (real > 0 && est > 0) return '<span class="badge-real" title="窗口内部分天有真实费用、其余按单价估算">实+估</span>';
  if (real > 0) return '<span class="badge-real" title="花费为数据中记录的真实费用">实</span>';
  if (est > 0) return '<span class="badge-est" title="窗口内无真实费用，按配置单价估算">估</span>';
  return '';
}

function sortRows(rows, sortState) {
  const { key, dir } = sortState;
  return [...rows].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

export function renderCards(el, totals, sessionCount, mf) {
  const denom = totals.cacheRead + totals.input;
  const hitRate = denom > 0 ? (totals.cacheRead / denom) * 100 : 0;
  const cards = [
    ['总 token', fmt(totals.totalTokens), fmtFull(totals.totalTokens)],
    ['输入(未命中)', fmt(totals.input), fmtFull(totals.input)],
    ['输出', fmt(totals.output), fmtFull(totals.output)],
    ['缓存命中', fmt(totals.cacheRead), fmtFull(totals.cacheRead)],
    ['缓存命中率', hitRate.toFixed(1) + '%', ''],
    ['会话数', String(sessionCount), ''],
    ['消息数', fmt(Math.round(totals.messages)), ''],
    [
      '花费',
      mf(totals.cost),
      `实 ${mf(totals.cost - totals.estCost)} · 估 ${mf(totals.estCost)}`,
    ],
  ];
  el.innerHTML = cards
    .map(([k, v, full]) => `<div class="card ${k === '花费' ? 'cost' : ''}"><div class="k">${k}</div><div class="v">${v}<small>${full}</small></div></div>`)
    .join('');
}

export function renderWorkspaceTable(el, rows, sortState, activeCwd, mf) {
  const sorted = sortRows(rows, sortState);
  el.querySelector('tbody').innerHTML =
    sorted
      .map(
        (w) => `
      <tr class="clickable ${activeCwd === w.key ? 'active' : ''}" data-cwd="${esc(w.key)}">
        <td class="path" title="${esc(w.key)}">${esc(w.key)}</td>
        <td class="num">${w.sessions}</td>
        <td class="num" title="${fmtFull(w.totalTokens)}">${fmt(w.totalTokens)}</td>
        <td class="num">${fmt(w.input)}</td>
        <td class="num">${fmt(w.output)}</td>
        <td class="num">${fmt(w.cacheRead)}</td>
        <td class="num">${fmt(w.cacheWrite)}</td>
        <td class="num money">${mf(w.cost)}</td>
      </tr>`,
      )
      .join('') || '<tr><td colspan="8" class="empty">无数据</td></tr>';
}

export function renderModelTable(tableEl, rows, sortState, totalAll, mf) {
  const sorted = sortRows(rows, sortState);
  tableEl.querySelector('tbody').innerHTML =
    sorted
      .map((m) => {
        const tag = costTag(m.realCost, m.estCost);
        return `
      <tr>
        <td class="path" title="${esc(m.key)}">${esc(m.key)}</td>
        <td class="num">${m.sessions}</td>
        <td class="num" title="${fmtFull(m.input)}">${fmt(m.input)}</td>
        <td class="num" title="${fmtFull(m.output)}">${fmt(m.output)}</td>
        <td class="num" title="${fmtFull(m.cacheRead)}">${fmt(m.cacheRead)}</td>
        <td class="num" title="${fmtFull(m.cacheWrite)}">${fmt(m.cacheWrite)}</td>
        <td class="num" title="${fmtFull(m.reasoning)}">${fmt(m.reasoning)}</td>
        <td class="num" title="${fmtFull(m.totalTokens)}">${fmt(m.totalTokens)}</td>
        <td class="num">${m.pct.toFixed(1)}%</td>
        <td class="num">${m.realCost > 0 ? mf(m.realCost) : '-'}</td>
        <td class="num">${mf(m.estCost)}</td>
        <td class="num money">${mf(m.cost)}${tag}</td>
      </tr>`;
      })
      .join('') || '<tr><td colspan="12" class="empty">当前窗口内无模型用量</td></tr>';

  // 合计行：与表头逐列对齐（12 列），每列都给总数
  const t = rows.reduce(
    (acc, m) => {
      acc.sessions += m.sessions;
      acc.input += m.input;
      acc.output += m.output;
      acc.cacheRead += m.cacheRead;
      acc.cacheWrite += m.cacheWrite;
      acc.reasoning += m.reasoning;
      acc.totalTokens += m.totalTokens;
      acc.realCost += m.realCost;
      acc.estCost += m.estCost;
      acc.cost += m.cost;
      return acc;
    },
    { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, realCost: 0, estCost: 0, cost: 0 },
  );
  const foot = tableEl.querySelector('tfoot');
  if (foot) {
    foot.innerHTML = rows.length
      ? `<tr>
          <td>合计</td>
          <td class="num">${t.sessions}</td>
          <td class="num" title="${fmtFull(t.input)}">${fmt(t.input)}</td>
          <td class="num" title="${fmtFull(t.output)}">${fmt(t.output)}</td>
          <td class="num" title="${fmtFull(t.cacheRead)}">${fmt(t.cacheRead)}</td>
          <td class="num" title="${fmtFull(t.cacheWrite)}">${fmt(t.cacheWrite)}</td>
          <td class="num" title="${fmtFull(t.reasoning)}">${fmt(t.reasoning)}</td>
          <td class="num" title="${fmtFull(t.totalTokens)}">${fmt(t.totalTokens)}</td>
          <td class="num">100%</td>
          <td class="num">${t.realCost > 0 ? mf(t.realCost) : '-'}</td>
          <td class="num">${mf(t.estCost)}</td>
          <td class="num money">${mf(t.cost)}</td>
        </tr>`
      : '';
  }
}

// ---------- 会话明细：渐进渲染 ----------
// 863+ 行一次性 innerHTML 重建拖慢每次交互；改为先渲染一小批，
// 滚动到底（哨兵进入视口）再追加下一批。筛选 / 排序变化时从头重置。
const SESS_BATCH = 150;
const sessRender = { rows: [], mf: null, cursor: 0 };

function sessRowHtml(r) {
  const tag = costTag(r.real, r.est);
  const arc = r.archived ? '<span class="badge-est" title="源会话已删除，此为本地保留的历史归档">档</span>' : '';
  return `
      <tr>
        <td title="${esc(r.name)}">
          <div class="sess-name">${esc(r.name)}${arc}</div>
          <div class="sess-id" title="会话 ID: ${esc(r.id)}">${esc(r.id)}</div>
        </td>
        <td class="path" title="${esc(r.cwd)}">${esc(r.cwd)}</td>
        <td class="num" title="${r.startTs ? esc(new Date(r.startTs).toLocaleString('zh-CN')) : ''}">${fmtDateTime(r.startTs)}</td>
        <td class="num">${fmtDuration(r.durationMs)}</td>
        <td class="num" title="${fmtFull(r.totalTokens)}">${fmt(r.totalTokens)}</td>
        <td class="num">${fmt(r.input)}</td>
        <td class="num">${fmt(r.output)}</td>
        <td class="num">${fmt(r.cacheRead)}</td>
        <td class="num">${r.hitRate.toFixed(1)}%</td>
        <td class="num">${r.messages}</td>
        <td class="num money">${sessRender.mf(r.cost)}${tag}</td>
        <td>${esc(r.topModel)}</td>
      </tr>`;
}

/** 重置并渲染第一批（renderAll 每次调用；rows 为富化+排序后的数据） */
export function renderSessionTable(el, enrichedRows, sortState, mf) {
  const rows = enrichedRows.map((e) => {
    const startTs = e.s.startTs || null;
    const endTs = e.s.endTs || null;
    const durMs = startTs && endTs ? new Date(endTs) - new Date(startTs) : 0;
    return {
      name: e.s.name,
      id: e.s.id,
      cwd: e.s.cwd,
      startTs,
      durationMs: Number.isFinite(durMs) && durMs > 0 ? durMs : 0,
      totalTokens: e.wu.totalTokens,
      input: e.wu.input,
      output: e.wu.output,
      cacheRead: e.wu.cacheRead,
      hitRate: e.hitRate,
      messages: Math.round((e.s.messages || 0) * e.ratio),
      cost: e.cost,
      est: e.est,
      real: e.real,
      topModel: e.topModel,
      archived: !!e.s.archived,
    };
  });
  const sorted = sortRows(rows, sortState);
  sessRender.rows = sorted;
  sessRender.mf = mf;
  sessRender.cursor = 0;
  const tbody = el.querySelector('tbody');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">当前筛选下无匹配会话</td></tr>';
    sessRender.cursor = 0;
    return;
  }
  const first = sorted.slice(0, SESS_BATCH).map(sessRowHtml).join('');
  tbody.innerHTML = first;
  sessRender.cursor = Math.min(SESS_BATCH, sorted.length);
}

/** 已渲染批数尽头时由滚动哨兵调用；返回是否还有剩余 */
export function appendSessionBatch(el) {
  if (!sessRender.rows.length || sessRender.cursor >= sessRender.rows.length) return false;
  const next = sessRender.rows.slice(sessRender.cursor, sessRender.cursor + SESS_BATCH);
  el.querySelector('tbody').insertAdjacentHTML('beforeend', next.map(sessRowHtml).join(''));
  sessRender.cursor += next.length;
  return sessRender.cursor < sessRender.rows.length;
}

/**
 * 「按服务商分组看模型」表：provider 合计行（粗体）+ 旗下模型缩进行。
 * 口径 = 窗口内活跃会话的全量数据（同「按提供商」视图）。
 */
export function renderProviderModelTable(tableEl, groups, mf) {
  const tbody = tableEl.querySelector('tbody');
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">当前窗口内无模型用量</td></tr>';
    const foot = tableEl.querySelector('tfoot');
    if (foot) foot.innerHTML = '';
    return;
  }
  const numCell = (v, extra = '') =>
    `<td class="num"${extra ? ` title="${fmtFull(v)}"` : ''}>${fmt(v)}</td>`;
  const costCell = (r) => {
    const tag = costTag(r.realCost, r.estCost);
    return `<td class="num">${r.realCost > 0 ? mf(r.realCost) : '-'}</td><td class="num">${mf(r.estCost)}</td><td class="num money">${mf(r.cost)}${tag}</td>`;
  };
  const parts = [];
  for (const g of groups) {
    parts.push(`
      <tr class="prov-group">
        <td class="path" title="${esc(g.key)}">▸ ${esc(g.key)}</td>
        <td class="num">${g.sessions}</td>
        ${numCell(g.input)} ${numCell(g.output)} ${numCell(g.cacheRead)} ${numCell(g.cacheWrite)} ${numCell(g.reasoning)} ${numCell(g.totalTokens)}
        <td class="num">${g.pct.toFixed(1)}%</td>
        ${costCell(g)}
      </tr>`);
    for (const m of g.models) {
      parts.push(`
      <tr class="prov-model">
        <td class="path" title="${esc(m.raw)}">└ ${esc(m.key)}</td>
        <td class="num">${m.sessions}</td>
        ${numCell(m.input)} ${numCell(m.output)} ${numCell(m.cacheRead)} ${numCell(m.cacheWrite)} ${numCell(m.reasoning)} ${numCell(m.totalTokens)}
        <td class="num">${m.pct.toFixed(1)}%</td>
        ${costCell(m)}
      </tr>`);
    }
  }
  tbody.innerHTML = parts.join('');
  const foot = tableEl.querySelector('tfoot');
  if (foot) foot.innerHTML = '';
}

// 「按天用量」表：逐日汇总行 + 全列合计（12 列对齐；会话列合计 = 会话×天）
export function renderDayTable(tableEl, rows, sortState, mf) {
  const sorted = sortRows(rows, sortState);
  tableEl.querySelector('tbody').innerHTML =
    sorted
      .map((d) => {
        const tag = costTag(d.realCost, d.estCost);
        return `
      <tr>
        <td title="${esc(d.key)}">${fmtDay(d.key)}</td>
        <td class="num">${d.sessions}</td>
        <td class="num">${fmt(Math.round(d.messages))}</td>
        <td class="num" title="${fmtFull(d.input)}">${fmt(d.input)}</td>
        <td class="num" title="${fmtFull(d.output)}">${fmt(d.output)}</td>
        <td class="num" title="${fmtFull(d.cacheRead)}">${fmt(d.cacheRead)}</td>
        <td class="num" title="${fmtFull(d.cacheWrite)}">${fmt(d.cacheWrite)}</td>
        <td class="num" title="${fmtFull(d.reasoning)}">${fmt(d.reasoning)}</td>
        <td class="num" title="${fmtFull(d.totalTokens)}">${fmt(d.totalTokens)}</td>
        <td class="num">${d.realCost > 0 ? mf(d.realCost) : '-'}</td>
        <td class="num">${mf(d.estCost)}</td>
        <td class="num money">${mf(d.cost)}${tag}</td>
      </tr>`;
      })
      .join('') || '<tr><td colspan="12" class="empty">当前窗口内无按天用量</td></tr>';

  const t = rows.reduce(
    (acc, d) => {
      acc.sessions += d.sessions;
      acc.messages += d.messages;
      acc.input += d.input;
      acc.output += d.output;
      acc.cacheRead += d.cacheRead;
      acc.cacheWrite += d.cacheWrite;
      acc.reasoning += d.reasoning;
      acc.totalTokens += d.totalTokens;
      acc.realCost += d.realCost;
      acc.estCost += d.estCost;
      acc.cost += d.cost;
      return acc;
    },
    { sessions: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, realCost: 0, estCost: 0, cost: 0 },
  );
  const foot = tableEl.querySelector('tfoot');
  if (foot) {
    foot.innerHTML = rows.length
      ? `<tr>
          <td>合计</td>
          <td class="num" title="逐日活跃会话数之和（会话×天，非去重）">${t.sessions}</td>
          <td class="num">${fmt(Math.round(t.messages))}</td>
          <td class="num" title="${fmtFull(t.input)}">${fmt(t.input)}</td>
          <td class="num" title="${fmtFull(t.output)}">${fmt(t.output)}</td>
          <td class="num" title="${fmtFull(t.cacheRead)}">${fmt(t.cacheRead)}</td>
          <td class="num" title="${fmtFull(t.cacheWrite)}">${fmt(t.cacheWrite)}</td>
          <td class="num" title="${fmtFull(t.reasoning)}">${fmt(t.reasoning)}</td>
          <td class="num" title="${fmtFull(t.totalTokens)}">${fmt(t.totalTokens)}</td>
          <td class="num">${t.realCost > 0 ? mf(t.realCost) : '-'}</td>
          <td class="num">${mf(t.estCost)}</td>
          <td class="num money">${mf(t.cost)}</td>
        </tr>`
      : '';
  }
}
