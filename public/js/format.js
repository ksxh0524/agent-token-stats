// 纯格式化工具（无 DOM 依赖，可被 node:test 直接测试）

// 中文数量级：万（1e4）/ 亿（1e8）。≥100 不带小数，其余保留 1 位并去掉尾零（14亿 / 1.4亿 / 3500万）
function zhUnit(v, unit) {
  const x = v >= 100 ? Math.round(v) : parseFloat(v.toFixed(1));
  return String(x) + unit;
}

export function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return zhUnit(n / 1e8, '亿');
  if (n >= 1e4) return zhUnit(n / 1e4, '万');
  return String(Math.round(n));
}

export function fmtFull(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 把 ¥ 金额换算为显示币种。rate = 1 单位外币 = N ¥（¥ 固定为 1）
export function money(cny, symbol = '¥', rate = 1) {
  const v = (Number(cny) || 0) / (rate || 1);
  const s = symbol || '¥';
  if (Math.abs(v) < 1000) return s + v.toFixed(2);
  return s + Math.round(v).toLocaleString('en-US');
}

// ISO 时间 → 本地时区短格式（同年 MM-DD HH:mm，跨年带年份）；空/坏值返回 '—'
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString('zh-CN', sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

// 毫秒时长 → 中文口径（42秒 / 5分12秒 / 3时42分 / 2天3时）；无效返回 '—'
export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 0 ? `${s % 60}秒` : `${m}分${s % 60 ? `${s % 60}秒` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 0 ? `${m}分` : `${h}时${m % 60 ? `${m % 60}分` : ''}`;
  const d = Math.floor(h / 24);
  return d === 0 ? `${h}时` : `${d}天${h % 24 ? `${h % 24}时` : ''}`;
}

// YYYY-MM-DD → 短日期 + 星期（同年 MM-DD 周X，跨年带年份）；坏值原样返回
export function fmtDay(ds) {
  if (!ds) return '—';
  const d = new Date(`${ds}T00:00:00`); // 纯日期按本地时区零点解析，避免 UTC 偏移串天
  if (Number.isNaN(d.getTime())) return String(ds);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString('zh-CN', sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' });
  const wd = d.toLocaleDateString('zh-CN', { weekday: 'short' });
  return `${date} ${wd}`;
}
