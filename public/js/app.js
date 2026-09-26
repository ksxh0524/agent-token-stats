// 入口：装配状态、数据加载、交互绑定与渲染循环。
import { state, loadPrefs, savePrefs } from './state.js';
import { getData, saveConfig, syncPrices } from './api.js';
import { aggregate, enrichSession, sessionInWindow, aggregateProviderModels } from './aggregate.js';
import {
  renderCards,
  renderWorkspaceTable,
  renderDayTable,
  renderModelTable,
  renderProviderModelTable,
  renderSessionTable,
  appendSessionBatch,
  moneyFmt,
} from './render.js';
import { mountRangePicker } from './calendar.js';
import { zeroPrice } from './defaults.js';
import { esc } from './format.js';

const $ = (sel) => document.querySelector(sel);

let rangePicker = null; // mountRangePicker 句柄（bind() 里赋值），用于首次加载后刷新默认窗口显示

// 工作区展示阈值：窗口内总 token 低于该值的工作区不显示（表格 + 下拉），过滤噪音
const MIN_WS_TOKENS = 1e6;

// ---------- 默认窗口：近 30 天（系统本地时区，与后端按天口径一致） ----------
function localToday(generatedAt) {
  return new Date(generatedAt).toLocaleDateString('en-CA'); // 无 timeZone = 浏览器本地时区
}
function addDaysStr(ds, delta) {
  const [y, m, d] = ds.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}
function defaultWin(days = 3, today = localToday(new Date().toISOString())) {
  return { from: addDaysStr(today, -(days - 1)), to: today };
}

// ---------- 数据加载 ----------
// lastRev = 服务端数据版本号（落库版本 + 价格配置指纹）。轮询带上它，
// 数据没变化时服务端只回 {unchanged:true}，跳过大载荷解析与全部重渲染。
let lastRev = null;
let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    const data = await getData(lastRev);
    if (data.unchanged) {
      if (state.data) updateMeta(state.data, true);
      else lastRev = null; // 理论上首次不会命中短路；兜底下轮拿全量
      return;
    }
    lastRev = data.revision;
    state.data = data;
    state.status = 'ok';
    if (!state.win) {
      state.win = defaultWin(3, localToday(data.generatedAt)); // 默认近 3 天
      rangePicker?.refresh(); // 首次加载后让选择器立即显示默认的「近3天」
    }
    $('#connBanner').hidden = true;
    syncCurrencySelect();
    updateSrcTabs();
    buildWsSelect();
    buildSettings();
    renderAll();
    updateMeta(data);
  } catch (err) {
    state.status = 'error';
    const banner = $('#connBanner');
    banner.hidden = false;
    $('#connText').textContent = `无法获取数据：${err && err.message ? err.message : err}（显示的是上次结果）`;
  } finally {
    loading = false;
  }
}

// meta 行：最后更新时间 / 会话数 / 各数据源概况（key 动态生成，新源自动出现）
function updateMeta(data, unchanged = false) {
  const srcParts = Object.entries(data.sources || {}).map(
    ([k, v]) => `${k} ${v?.sessions ?? 0}${v?.error ? '（异常）' : ''}`,
  );
  $('#meta').textContent =
    `最后更新 ${new Date(data.generatedAt).toLocaleString('zh-CN')} · ${data.sessions.length} 会话` +
    (srcParts.length ? ` · ${srcParts.join(' / ')}` : '') +
    (data.skippedLines ? ` · 坏行 ${data.skippedLines}` : '') +
    (unchanged ? ' · 无新数据' : '');
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

  // 按天用量（aggregate 的 days 维度：逐日汇总，花费为「模型×天」真实优先口径）
  $('#dayTag').textContent =
    `${viewAgg.days.length} 天 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}` +
    (state.workspace !== 'ALL' ? ` · 仅工作区 ${state.workspace}` : '');
  renderDayTable($('#dayTable'), viewAgg.days, state.sort.day, mf);

  // 模型明细：仅模型 / 按服务商 两个视图
  $('#modelTag').textContent =
    `${viewAgg.models.length} 个模型 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}` +
    (state.workspace !== 'ALL' ? ` · 仅工作区 ${state.workspace}` : '');
  document.querySelectorAll('#modelViewSwitch button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mv === state.modelView),
  );
  $('#provToggle').hidden = state.modelView !== 'provider';
  if (state.modelView === 'provider') {
    const groups = aggregateProviderModels({ sessions: base, prices: state.data.prices, win, aliases });
    $('#modelTag').textContent = `${groups.length} 个服务商 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}` +
      (state.workspace !== 'ALL' ? ` · 仅工作区 ${state.workspace}` : '') + ' · 全会话口径';
    document.querySelector('#modelTable th[data-k="key"]').textContent = '服务商 / 模型';
    renderProviderModelTable($('#modelTable'), groups, mf, new Set(state.collapsedProviders));
  } else {
    document.querySelector('#modelTable th[data-k="key"]').textContent = '模型';
    renderModelTable($('#modelTable'), viewAgg.models, state.sort.model, viewAgg.totals.totalTokens, mf);
  }
  const rateNote =
    state.currency === '¥' ? '' : `；显示币种 ${state.currency} 按 1 ${state.currency} = ${state.data.rates?.[state.currency] ?? '?'} ¥ 换算`;
  $('#costNote').textContent =
    `单价以 ¥ 计价。「实」= 数据中记录的真实费用；「估」= 无真实费用时按配置单价推算；「实+估」= 窗口内两种口径混合（部分天有真实费用）。${rateNote}`;

  // 会话明细
  const enriched = base.filter((s) => sessionInWindow(s, win)).map((s) => enrichSession(s, state.data.prices, win));
  $('#sessTag').textContent = `${enriched.length} 个会话 · 窗口 ${win.from || '最早'} ~ ${win.to || '今天'}`;
  renderSessionTable($('#sessTable'), enriched, state.sort.sess, mf);
}

// ---------- 数据源 tab / 工作区下拉 ----------
// 数据源 tab 按 /api/data 的 sources key 动态生成（新源接入前端零改动）；
// 标签带会话数；当前源不可用时自动落到有数据的源
function updateSrcTabs() {
  const stats = state.data?.sources || {};
  const sessions = state.data?.sessions || [];
  const seen = [...new Set([...Object.keys(stats), ...sessions.map((s) => s.source)])];
  const available = seen.filter((k) => (stats[k] && stats[k].enabled) || sessions.some((s) => s.source === k));
  if (!available.includes(state.source)) {
    state.source = available[0] || 'pi';
    savePrefs();
  }
  $('#srcTabs').innerHTML =
    seen
      .map((k) => {
        const n = stats[k]?.sessions ?? sessions.filter((s) => s.source === k).length;
        const mark = stats[k] && !stats[k].enabled ? ' ⚠' : '';
        const active = k === state.source ? ' class="active"' : '';
        return `<button data-src="${esc(k)}"${active}>${esc(k)}（${n}${mark}）</button>`;
      })
      .join('') || '';
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

  // 价格表列出的模型 = 已配置的 + 本地用到的（不再有硬编码的内置默认价名单）
  const models = new Set([
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

  // 汇率不再让用户填：服务端每天自动拉（见 src/rates.ts），界面只选显示币种
  $('#aliasEditor').value = Object.entries(state.data.modelAliases || {})
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');
}

// DOM 里只有当前渲染出来的行，所以基准必须是服务端配置，
// 否则表格状态不完整时保存会把没渲染出来的模型删掉
function readPrices() {
  const out = JSON.parse(JSON.stringify(state.data?.prices || {}));
  document.querySelectorAll('#priceTable tbody input[type=number]').forEach((inp) => {
    const m = inp.dataset.m;
    if (!m) return;
    out[m] ||= zeroPrice();
    const v = parseFloat(inp.value);
    out[m][inp.dataset.f] = Number.isFinite(v) && v >= 0 ? v : 0;
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

// 所有配置改动都走这里实时落盘（服务端 prices.json 是唯一事实源）。返回是否成功，供调用方给提示。
async function pushConfig(extra = {}) {
  // 数据没加载完就保存 = 用空配置覆盖服务端，直接拒掉
  if (!state.data) {
    alert('数据还没加载完，请稍后再试');
    return false;
  }
  // 汇率由服务端每天自动更新（src/rates.ts），原样带回去别把它清掉
  const cfg = { currency: '¥', rates: state.data.rates || {}, prices: readPrices(), modelAliases: readAliases(), ...extra };
  try {
    await saveConfig(cfg, { allowEmpty: !!extra.allowEmpty });
    settingsBuiltFor = '';
    await load();
    return true;
  } catch (err) {
    alert('保存失败：' + (err && err.message ? err.message : err));
    return false;
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

// ---------- 按服务商视图：收起 / 展开 ----------
// 纯 DOM 切换（不重跑聚合）：合计行带 data-prov，紧跟其后的 prov-model 行都属于它。
function setProvCollapsed(tr, collapsed) {
  tr.classList.toggle('collapsed', collapsed);
  tr.title = `点击${collapsed ? '展开' : '收起'}该服务商`;
  const arrow = tr.querySelector('.prov-arrow');
  if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
  for (let sib = tr.nextElementSibling; sib && sib.classList.contains('prov-model'); sib = sib.nextElementSibling) {
    sib.classList.toggle('is-hidden', collapsed);
  }
}

function setCollapsedProviders(keys) {
  state.collapsedProviders = [...new Set(keys)];
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

  // tab 按钮是动态生成的，事件挂在容器上（委托），新源按钮无需重新绑定
  $('#srcTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-src]');
    if (b) switchSource(b.dataset.src);
  });

  // 会话表懒加载：滚动接近表格尾部时追加下一批。
  // while：哨兵持续可见（剩余内容不满一屏）时一次回调要把剩余批次追完
  const sessScroll = document.querySelector('.sess-scroll');
  if (sessScroll && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      () => {
        while (appendSessionBatch($('#sessTable')));
      },
      { root: sessScroll, rootMargin: '200px' },
    );
    io.observe($('#sessSentinel'));
  } else {
    // 保险丝：不支持 IntersectionObserver 就退化成滚动到底追加
    sessScroll?.addEventListener('scroll', () => {
      if (sessScroll.scrollTop + sessScroll.clientHeight >= sessScroll.scrollHeight - 120)
        while (appendSessionBatch($('#sessTable')));
    });
  }

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
  bindSort('#dayTable th[data-k]', 'day');
  bindSort('#sessTable th[data-k]', 'sess');
  bindSort('#modelTable th[data-k]', 'model');

  // 按服务商：点合计行收起/展开那一家；「全部收起/全部展开」一次到底。状态存进偏好，刷新后保持。
  $('#modelTable tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.prov-group');
    if (!tr) return;
    const collapsed = !tr.classList.contains('collapsed');
    setProvCollapsed(tr, collapsed);
    const set = new Set(state.collapsedProviders);
    if (collapsed) set.add(tr.dataset.prov);
    else set.delete(tr.dataset.prov);
    setCollapsedProviders(set);
  });
  $('#provToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-prov-all]');
    if (!b) return;
    const collapse = b.dataset.provAll === 'collapse';
    const rows = [...document.querySelectorAll('#modelTable tbody tr.prov-group')];
    rows.forEach((tr) => setProvCollapsed(tr, collapse));
    setCollapsedProviders(collapse ? rows.map((tr) => tr.dataset.prov) : []);
  });

  // 模型明细视图切换（仅模型 / 按服务商）
  $('#modelViewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mv]');
    if (!b || state.modelView === b.dataset.mv) return;
    state.modelView = b.dataset.mv;
    savePrefs();
    renderAll();
  });

  // 价格同步：只补本地用到的模型（会话里出现过的 + 已配置的），pi 配置优先于官方目录
  const SYNC_LABEL = '同步价格（pi + 官方目录）';
  const syncBtn = $('#syncPrices');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = '同步中…';
    $('#syncNote').textContent = '';
    try {
      const r = await syncPrices();
      const parts = [];
      if (r.filled?.length) parts.push(`已填 ${r.filled.length} 个（新增 ${r.added} · 补零 ${r.filledZero} · 纠正 ${r.corrected}）`);
      if (r.byProvider?.length)
        parts.push('价源：' + r.byProvider.slice(0, 3).map((p) => `${p.provider} ${p.count}`).join('、'));
      if (r.routed?.length)
        parts.push(
          '变体归并：' + r.routed.slice(0, 3).map((x) => `${x.variant}→${x.base}`).join('、') + (r.routed.length > 3 ? ' 等' : ''),
        );
      if (r.skipped?.length) parts.push(`保留手填 ${r.skipped.length} 个`);
      if (r.inScope) parts.push(`本地模型 ${r.inScope} 个`);
      if (!r.modelsDevOk) parts.push('⚠ models.dev 拉取失败，仅用 pi 配置');
      if (!r.piConfigured) parts.push('⚠ 未读到 pi 配置（~/.pi/agent/models.json）');
      $('#syncNote').textContent = parts.join(' · ') || '没有可同步的新价格';
      if (r.filled?.length || r.routed?.length) {
        settingsBuiltFor = '';
        await load();
      }
    } catch (err) {
      $('#syncNote').textContent = '同步失败：' + (err && err.message ? err.message : err);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = SYNC_LABEL;
    }
  });

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
  $('#clearPrices').addEventListener('click', () => {
    if (!confirm('清空所有模型单价？')) return;
    pushConfig({ prices: {}, allowEmpty: true });
  });
  $('#addBtn').addEventListener('click', () => {
    const v = $('#addModel').value.trim();
    if (!v) return;
    const p = readPrices();
    if (!p[v]) p[v] = zeroPrice();
    pushConfig({ prices: p });
    $('#addModel').value = '';
  });
  // 别名映射：失焦即保存（change 事件），没有「保存」按钮。
  // 用 change 而不是 input：别名一变服务端要全量重扫，逐键触发会反复重算。
  $('#aliasEditor').addEventListener('change', async () => {
    const note = $('#aliasNote');
    note.textContent = '保存中…';
    const ok = await pushConfig();
    note.textContent = ok ? '已保存' : '保存失败';
    if (ok) setTimeout(() => { if (note.textContent === '已保存') note.textContent = ''; }, 2500);
  });

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
