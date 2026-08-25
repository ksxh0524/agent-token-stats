// 入口：装配状态、数据加载、交互绑定与渲染循环。
import { state, loadPrefs, savePrefs } from './state.js';
import { getData, saveConfig } from './api.js';
import { aggregate, enrichSession, sessionInWindow } from './aggregate.js';
import {
  renderCards,
  renderWorkspaceTable,
  renderModelTable,
  renderSessionTable,
  renderBars,
  moneyFmt,
} from './render.js';
import { mountRangePicker } from './calendar.js';
import { DEFAULTS, zeroPrice } from './defaults.js';
import { esc } from './format.js';

const $ = (sel) => document.querySelector(sel);

// ---------- 默认窗口：近 30 天（Asia/Shanghai，与后端按天口径一致） ----------
function shanghaiToday(generatedAt) {
  return new Date(generatedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
function addDaysStr(ds, delta) {
  const [y, m, d] = ds.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}
function defaultWin(days = 30, today = shanghaiToday(new Date().toISOString())) {
  return { from: addDaysStr(today, -(days - 1)), to: today };
}

// ---------- 数据加载 ----------
let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    const data = await getData();
    state.data = data;
    state.status = 'ok';
    if (!state.win) state.win = defaultWin(30, shanghaiToday(data.generatedAt));
    $('#connBanner').hidden = true;
    syncCurrencySelect();
    buildWsSelect();
    buildSettings();
    renderAll();
    $('#meta').textContent =
      `最后更新 ${new Date(data.generatedAt).toLocaleString('zh-CN')} · ${data.sessions.length} 会话` +
      (data.skippedLines ? ` · 坏行 ${data.skippedLines}` : '');
  } catch (err) {
    state.status = 'error';
    const banner = $('#connBanner');
    banner.hidden = false;
    $('#connText').textContent = `无法获取数据：${err && err.message ? err.message : err}（显示的是上次结果）`;
  } finally {
    loading = false;
  }
}

function syncCurrencySelect() {
  $('#cur').value = state.currency;
}

// ---------- 过滤 ----------
function baseSessions() {
  let arr = state.data?.sessions || [];
  if (state.workspace !== 'ALL') arr = arr.filter((s) => s.cwd === state.workspace);
  const q = state.search.trim().toLowerCase();
  if (!q) return arr;
  arr = arr.filter(
    (s) => s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
  );
  // 搜索时 id 命中的排前面（便于按 ID 定位会话）
  return [...arr].sort((a, b) => {
    const ai = a.id.toLowerCase().includes(q) ? 1 : 0;
    const bi = b.id.toLowerCase().includes(q) ? 1 : 0;
    return bi - ai;
  });
}

// ---------- 渲染 ----------
function switchTab(tab) {
  state.tab = tab;
  savePrefs();
  renderAll();
}

function renderAll() {
  if (!state.data) return;
  const mf = moneyFmt(state);
  const win = state.win;
  const base = baseSessions();
  const aliases = state.data.modelAliases;

  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  for (const sec of ['overview', 'models', 'sessions', 'settings']) {
    $(`#tab-${sec}`).hidden = sec !== state.tab;
  }

  if (state.tab === 'overview') {
    const viewAgg = aggregate({ sessions: base, prices: state.data.prices, win, aliases });
    renderCards($('#cards'), viewAgg.totals, viewAgg.totals.sessions, mf);
    $('#wsTag').textContent = `${viewAgg.workspaces.length} 个工作区`;
    renderWorkspaceTable($('#wsTable'), viewAgg.workspaces, state.sort.ws, state.workspace, mf);
    $('#modelBarTag').textContent = `${viewAgg.models.length} 个模型 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}`;
    renderBars($('#models'), viewAgg.models, 15, mf);
    renderBars($('#providers'), viewAgg.providers, 20, mf);
  }

  if (state.tab === 'models') {
    const agg = aggregate({ sessions: base, prices: state.data.prices, win, aliases });
    $('#modelTag').textContent =
      `${agg.models.length} 个模型 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}` +
      (state.workspace !== 'ALL' ? ` · 仅工作区 ${state.workspace}` : '');
    renderModelTable($('#modelTable'), agg.models, state.sort.model, agg.totals.totalTokens, mf);
    const rateNote =
      state.currency === '¥' ? '' : `；显示币种 ${state.currency} 按 1 ${state.currency} = ${state.data.rates?.[state.currency] ?? '?'} ¥ 换算`;
    $('#costNote').textContent =
      `单价以 ¥ 计价。「实」= 数据中记录的真实费用；「估」= 无真实费用时按配置单价推算${rateNote}。`;
  }

  if (state.tab === 'sessions') {
    const enriched = base.filter((s) => sessionInWindow(s, win)).map((s) => enrichSession(s, state.data.prices, win));
    $('#sessTag').textContent = `${enriched.length} 个会话 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}`;
    renderSessionTable($('#sessTable'), enriched, state.sort.sess, mf);
  }
}

// ---------- 工作区下拉 ----------
function buildWsSelect() {
  const sel = $('#ws');
  const cwds = [...new Set((state.data.sessions || []).map((s) => s.cwd))].sort();
  sel.innerHTML =
    `<option value="ALL">全部工作区</option>` + cwds.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (state.workspace !== 'ALL' && !cwds.includes(state.workspace)) state.workspace = 'ALL';
  sel.value = state.workspace;
}

// ---------- 设置页 ----------
let settingsBuiltFor = '';
function buildSettings() {
  if (!state.data) return;
  const sig =
    JSON.stringify(state.data.prices) + '|' + JSON.stringify(state.data.rates) + '|' + JSON.stringify(state.data.modelAliases);
  if (sig === settingsBuiltFor) return;
  settingsBuiltFor = sig;

  const models = new Set([
    ...Object.keys(DEFAULTS),
    ...Object.keys(state.data.prices),
    ...(state.data.sessions || []).flatMap((s) => Object.keys(s.modelUsage || {})),
  ]);
  $('#priceTable tbody').innerHTML =
    [...models]
      .sort()
      .map((m) => {
        const p = state.data.prices[m] || zeroPrice();
        const cell = (f, v) =>
          `<td><input type="number" step="0.0001" min="0" value="${v}" data-m="${esc(m)}" data-f="${f}"></td>`;
        return `<tr>
          <td class="path" title="${esc(m)}">${esc(m)}</td>
          ${cell('input', p.input)} ${cell('output', p.output)} ${cell('cacheRead', p.cacheRead)} ${cell('cacheWrite', p.cacheWrite)}
          <td><button class="del" data-m="${esc(m)}" title="移除">×</button></td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="6" class="empty">无</td></tr>';

  const rates = state.data.rates || {};
  $('#ratesEditor').innerHTML = ['$', '€', '£', '₩']
    .map(
      (sym) =>
        `<label>${sym} <input type="number" step="0.0001" min="0" data-sym="${sym}" value="${rates[sym] ?? ''}" /></label>`,
    )
    .join('');

  $('#aliasEditor').value = Object.entries(state.data.modelAliases || {})
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');
}

function readPrices() {
  const out = {};
  document.querySelectorAll('#priceTable tbody input[type=number]').forEach((inp) => {
    const m = inp.dataset.m;
    if (!m) return;
    out[m] ||= zeroPrice();
    const v = parseFloat(inp.value);
    out[m][inp.dataset.f] = Number.isFinite(v) && v >= 0 ? v : 0;
  });
  return out;
}
function readRates() {
  const out = {};
  document.querySelectorAll('#ratesEditor input').forEach((inp) => {
    const v = parseFloat(inp.value);
    if (inp.dataset.sym && Number.isFinite(v) && v > 0) out[inp.dataset.sym] = v;
  });
  return out;
}
function readAliases() {
  const out = {};
  for (const line of $('#aliasEditor').value.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

async function pushConfig(extra = {}) {
  const cfg = { currency: '¥', rates: readRates(), prices: readPrices(), modelAliases: readAliases(), ...extra };
  try {
    await saveConfig(cfg);
    settingsBuiltFor = '';
    await load();
  } catch (err) {
    alert('保存失败：' + (err && err.message ? err.message : err));
  }
}

// ---------- 自动刷新 ----------
function setAuto(on) {
  state.auto = on;
  clearInterval(state.timer);
  if (on)
    state.timer = setInterval(() => {
      if (!document.hidden) load(); // 后台标签页暂停轮询
    }, 30000);
  savePrefs();
}

// ---------- 排序绑定 ----------
function bindSort(selector, sortKey) {
  document.querySelectorAll(selector).forEach((th) =>
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      const s = state.sort[sortKey];
      if (s.key === k) s.dir *= -1;
      else {
        s.key = k;
        s.dir = -1;
      }
      renderAll();
    }),
  );
}

// ---------- 绑定 ----------
function bind() {
  $('#refresh').addEventListener('click', load);
  $('#connRetry').addEventListener('click', load);
  $('#auto').addEventListener('change', (e) => setAuto(e.target.checked));
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#settingsBtn').addEventListener('click', () => switchTab('settings'));

  $('#cur').addEventListener('change', (e) => {
    state.currency = e.target.value;
    savePrefs();
    renderAll();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value;
      renderAll();
    }, 150);
  });

  mountRangePicker($('#range'), {
    win: () => state.win || { from: '', to: '' },
    onChange: (w) => {
      state.win = w;
      savePrefs();
      renderAll();
    },
  });

  $('#ws').addEventListener('change', (e) => {
    state.workspace = e.target.value;
    savePrefs();
    renderAll();
  });
  $('#wsTable tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-cwd]');
    if (!tr) return;
    const cwd = tr.dataset.cwd;
    state.workspace = state.workspace === cwd ? 'ALL' : cwd;
    $('#ws').value = state.workspace;
    savePrefs();
    renderAll();
  });

  bindSort('#wsTable th[data-k]', 'ws');
  bindSort('#sessTable th[data-k]', 'sess');
  bindSort('#modelTable th[data-k]', 'model');

  // 价格编辑：失焦/回车提交（change 事件），避免每敲一键按半截数字计算
  $('#priceTable tbody').addEventListener('change', (e) => {
    if (e.target.tagName === 'INPUT') pushConfig();
  });
  $('#priceTable tbody').addEventListener('click', (e) => {
    const b = e.target.closest('.del');
    if (!b) return;
    delete state.data.prices[b.dataset.m];
    pushConfig({ prices: readPricesAfterDelete(b.dataset.m) });
  });
  function readPricesAfterDelete(m) {
    const p = readPrices();
    delete p[m];
    return p;
  }
  $('#fillDefaults').addEventListener('click', () =>
    pushConfig({ prices: { ...readPrices(), ...JSON.parse(JSON.stringify(DEFAULTS)) } }),
  );
  $('#clearPrices').addEventListener('click', () => pushConfig({ prices: {} }));
  $('#addBtn').addEventListener('click', () => {
    const v = $('#addModel').value.trim();
    if (!v) return;
    const p = readPrices();
    if (!p[v]) p[v] = zeroPrice();
    pushConfig({ prices: p });
    $('#addModel').value = '';
  });
  $('#saveRates').addEventListener('click', () => pushConfig());
  $('#saveAlias').addEventListener('click', () => pushConfig());

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.auto) load(); // 回到前台立即刷新一次
  });
}

// ---------- 启动 ----------
loadPrefs();
bind();
$('#auto').checked = state.auto;
if (state.auto) setAuto(true);
load();
