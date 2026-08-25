// 纯格式化工具（无 DOM 依赖，可被 node:test 直接测试）

export function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
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
