// 日期范围选择器（单月网格 + 快捷区间），自包含组件。
// 用法：mountRangePicker(container, { win, onChange })
//  - onChange(win) 在应用新范围时回调（win = {from,to}，from/to 均为 '' 表示全部）

const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const parseYmd = (s) => (s ? (([y, m, d]) => ({ y, m: m - 1, d }))(s.split('-').map(Number)) : null);
const todayStr = () => {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth(), t.getDate());
};
function addMonths(y, m, delta) {
  const nm = m + delta;
  return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
}
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

export function mountRangePicker(container, { win, onChange }) {
  const cal = { open: false, view: null, start: null, end: null, hover: null };

  container.innerHTML = `
    <div class="range" id="range">
      <button type="button" class="range-trigger">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span class="range-text"></span>
        <span class="range-clear" title="清除" hidden>×</span>
      </button>
      <div class="range-pop" hidden>
        <div class="range-presets">
          <button type="button" data-p="7">近7天</button>
          <button type="button" data-p="30">近30天</button>
          <button type="button" data-p="90">近90天</button>
          <button type="button" data-p="all">全部</button>
        </div>
        <div class="range-cal-head">
          <button type="button" class="range-nav" data-nav="-1">‹</button>
          <span class="range-cal-title"></span>
          <button type="button" class="range-nav" data-nav="1">›</button>
        </div>
        <div class="range-grid"></div>
        <div class="range-foot">
          <button type="button" class="range-clearbtn">清除</button>
          <button type="button" class="range-apply">确定</button>
        </div>
      </div>
    </div>`;

  const root = container.querySelector('.range');
  const trigger = root.querySelector('.range-trigger');
  const pop = root.querySelector('.range-pop');
  const textEl = root.querySelector('.range-text');
  const clearEl = root.querySelector('.range-clear');
  const grid = root.querySelector('.range-grid');
  const title = root.querySelector('.range-cal-title');

  function inRange(ds) {
    const a = cal.start;
    const b = cal.end || cal.hover;
    if (a && b) return (a <= ds && ds <= b) || (b <= ds && ds <= a);
    return false;
  }

  function renderText() {
    const from = cal.open ? cal.start || '' : win().from || '';
    const to = cal.open ? cal.end || '' : win().to || '';
    if (from || to) {
      textEl.textContent = `${from || '最早'} ~ ${to || (cal.open ? '选择结束' : '今天')}`;
      clearEl.hidden = false;
    } else {
      textEl.textContent = '时间范围';
      clearEl.hidden = true;
    }
  }

  function renderCal() {
    if (!cal.view) cal.view = parseYmd(win().from) || parseYmd(win().to) || parseYmd(todayStr());
    const { y, m } = cal.view;
    title.textContent = `${y}年${m + 1}月`;
    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    const first = new Date(y, m, 1).getDay();
    const dim = daysInMonth(y, m);
    const t = todayStr();
    let h = wd.map((w) => `<div class="range-wd">${w}</div>`).join('');
    for (let i = 0; i < first; i++) h += '<div class="range-day empty"></div>';
    for (let d = 1; d <= dim; d++) {
      const ds = ymd(y, m, d);
      const cls = ['range-day'];
      if (ds === t) cls.push('today');
      if (ds === cal.start) cls.push('start');
      if (ds === cal.end) cls.push('end');
      else if (inRange(ds)) cls.push('in');
      h += `<div class="${cls.join(' ')}" data-d="${ds}">${d}</div>`;
    }
    grid.innerHTML = h;
  }

  function syncWinFromCal() {
    onChange({ from: cal.start || '', to: cal.end || '' });
  }

  function open() {
    cal.open = true;
    cal.start = win().from || null;
    cal.end = win().to || null;
    cal.hover = null;
    cal.view = parseYmd(win().from) || parseYmd(win().to) || parseYmd(todayStr());
    pop.hidden = false;
    renderCal();
    renderText();
  }
  function close() {
    cal.open = false;
    pop.hidden = true;
    renderText();
  }
  function apply() {
    syncWinFromCal();
    close();
  }
  function pick(ds) {
    if (!cal.start || (cal.start && cal.end)) {
      cal.start = ds;
      cal.end = null;
      cal.hover = null;
    } else if (ds < cal.start) {
      cal.start = ds;
    } else {
      cal.end = ds;
    }
    renderCal();
    renderText();
    if (cal.start && cal.end) apply(); // 选满区间立即生效
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    cal.open ? close() : open();
  });
  clearEl.addEventListener('click', (e) => {
    e.stopPropagation();
    cal.start = cal.end = null;
    onChange({ from: '', to: '' });
    close();
  });
  // 点日期阻止冒泡：renderCal 会重建 DOM，冒泡到 document 的关闭监听会误关弹层
  grid.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target.closest('.range-day');
    if (t && t.dataset.d) pick(t.dataset.d);
  });
  grid.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.range-day');
    if (!t || !t.dataset.d || !cal.start || cal.end) return;
    cal.hover = t.dataset.d;
    grid.querySelectorAll('.range-day[data-d]').forEach((cell) => {
      cell.classList.toggle('in', inRange(cell.dataset.d) && cell.dataset.d !== cal.start && cell.dataset.d !== cal.end);
    });
  });
  grid.addEventListener('mouseleave', () => {
    cal.hover = null;
    grid.querySelectorAll('.range-day.in').forEach((c) => c.classList.remove('in'));
  });
  root.querySelectorAll('.range-nav').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cal.view = addMonths(cal.view.y, cal.view.m, Number(btn.dataset.nav));
      renderCal();
    }),
  );
  root.querySelector('.range-presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    const p = b.dataset.p;
    if (p === 'all') {
      cal.start = cal.end = null;
      onChange({ from: '', to: '' });
    } else {
      const n = Number(p);
      const t = new Date();
      const s = new Date(t);
      s.setDate(t.getDate() - (n - 1));
      cal.start = ymd(s.getFullYear(), s.getMonth(), s.getDate());
      cal.end = ymd(t.getFullYear(), t.getMonth(), t.getDate());
      onChange({ from: cal.start, to: cal.end });
    }
    close();
  });
  root.querySelector('.range-apply').addEventListener('click', (e) => {
    e.stopPropagation();
    apply();
  });
  root.querySelector('.range-clearbtn').addEventListener('click', (e) => {
    e.stopPropagation();
    cal.start = cal.end = null;
    onChange({ from: '', to: '' });
    close();
  });
  document.addEventListener('click', (e) => {
    if (cal.open && !root.contains(e.target)) close();
  });

  renderText();
  return { refresh: renderText };
}
