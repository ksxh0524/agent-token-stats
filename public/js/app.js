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

let rangePicker = null; // mountRangePicker 句柄（bind() 里赋值），用于首次加载后刷新默认窗口显示

// 工作区展示阈值：窗口内总 token 低于该值的工作区不显示（表格 + 下拉），过滤噪音
const MIN_WS_TOKENS = 1e6;

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
function defaultWin(days = 3, today = shanghaiToday(new Date().toISOString())) {
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
    if (!state.win) {
      state.win = defaultWin(3, shanghaiToday(data.generatedAt)); // 默认近 3 天
      rangePicker?.refresh(); // 首次加载后让选择器立即显示默认的「近3天」
    }
    $('#connBanner').hidden = true;
    syncCurrencySelect();
    updateSrcTabs();
    buildWsSelect();
    buildSettings();
    renderAll();
    $('#meta').textContent =
      `最后更新 ${new Date(data.generatedAt).toLocaleString('zh-CN')} · ${data.sessions.length} 会话` +
      ` · pi ${data.sources?.pi?.sessions ?? 0} / opencode ${data.sources?.opencode?.sessions ?? 0}` +
      (data.skippedLines ? ` · 坏行 ${data.skippedLines}` : '') +
      (data.sources?.opencode?.error ? ` · opencode 源异常` : '');
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
  // 数据源严格分开：只看当前 tab 对应的会话
  let arr = (state.data?.sessions || []).filter((s) => s.source === state.source);
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
function renderAll() {
  if (!state.data) return;
  const mf = moneyFmt(state);
  const win = state.win;
  const base = baseSessions();
  const aliases = state.data.modelAliases;

  const viewAgg = aggregate({ sessions: base, prices: state.data.prices, win, aliases });

  // 总览
  renderCards($('#cards'), viewAgg.totals, viewAgg.totals.sessions, mf);
  const wsRows = viewAgg.workspaces.filter((w) => w.totalTokens >= MIN_WS_TOKENS);
  const wsHidden = viewAgg.workspaces.length - wsRows.length;
  $('#wsTag').textContent =
    `${wsRows.length} 个工作区` + (wsHidden ? ` · 已隐藏 ${wsHidden} 个小额（<${MIN_WS_TOKENS / 1e4}万 token）` : '');
  renderWorkspaceTable($('#wsTable'), wsRows, state.sort.ws, state.workspace, mf);
  $('#modelBarTag').textContent = `${viewAgg.models.length} 个模型 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}`;
  renderBars($('#models'), viewAgg.models, 15, mf);
  renderBars($('#providers'), viewAgg.providers, 20, mf);

  // 模型明细
  $('#modelTag').textContent =
    `${viewAgg.models.length} 个模型 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}` +
    (state.workspace !== 'ALL' ? ` · 仅工作区 ${state.workspace}` : '');
  renderModelTable($('#modelTable'), viewAgg.models, state.sort.model, viewAgg.totals.totalTokens, mf);
  const rateNote =
    state.currency === '¥' ? '' : `；显示币种 ${state.currency} 按 1 ${state.currency} = ${state.data.rates?.[state.currency] ?? '?'} ¥ 换算`;
  $('#costNote').textContent =
    `单价以 ¥ 计价。「实」= 数据中记录的真实费用；「估」= 无真实费用时按配置单价推算${rateNote}。`;

  // 会话明细
  const enriched = base.filter((s) => sessionInWindow(s, win)).map((s) => enrichSession(s, state.data.prices, win));
  $('#sessTag').textContent = `${enriched.length} 个会话 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}`;
  renderSessionTable($('#sessTable'), enriched, state.sort.sess, mf);
}

// ---------- 数据源 tab / 工作区下拉 ----------
// 数据源 tab：标签带会话数；当前源不可用时自动落到有数据的源
function updateSrcTabs() {
  const stats = state.data?.sources || {};
  const sessions = state.data?.sessions || [];
  const available = ['pi', 'opencode'].filter(
    (k) => (stats[k] && stats[k].enabled) || sessions.some((s) => s.source === k),
  );
  if (!available.includes(state.source)) {
    state.source = available[0] || 'pi';
    savePrefs();
  }
  document.querySelectorAll('#srcTabs button').forEach((b) => {
    const k = b.dataset.src;
    const n = stats[k]?.sessions ?? sessions.filter((s) => s.source === k).length;
    b.classList.toggle('active', k === state.source);
    b.textContent = `${k}（${n}）`;
  });
}

function switchSource(src) {
  if (state.source === src) return;
  state.source = src;
  // 切换数据源后工作区列表会变化，重置避免残留失效筛选
  if (state.workspace !== 'ALL' && !buildWsOptions().includes(state.workspace)) state.workspace = 'ALL';
  savePrefs();
  updateSrcTabs(); // 刷新 tab 高亮
  buildWsSelect();
  renderAll();
}

// 当前数据源下的工作区选项（下拉与来源切换校验共用）。
// 只保留全量 token ≥ MIN_WS_TOKENS 的工作区，过滤一次性小目录噪音；已选中的始终保留。
function buildWsOptions() {
  const sessions = state.data?.sessions || [];
  const byCwd = new Map();
  for (const s of sessions) {
    if (s.source !== state.source) continue;
    byCwd.set(s.cwd, (byCwd.get(s.cwd) || 0) + (s.totalTokens || 0));
  }
  const opts = [...byCwd.entries()].filter(([, t]) => t >= MIN_WS_TOKENS).map(([c]) => c);
  if (state.workspace !== 'ALL' && !opts.includes(state.workspace)) opts.push(state.workspace);
  return opts.sort();
}

function buildWsSelect() {
  const sel = $('#ws');
  const cwds = buildWsOptions();
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

  // 设置面板：齿轮展开/收起
  const settingsPanel = $('#settingsPanel');
  $('#settingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.hidden = !settingsPanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target)) settingsPanel.hidden = true;
  });
  settingsPanel.addEventListener('click', (e) => e.stopPropagation());

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

  document.querySelectorAll('#srcTabs button').forEach((b) =>
    b.addEventListener('click', () => switchSource(b.dataset.src)),
  );

  rangePicker = mountRangePicker($('#range'), {
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
