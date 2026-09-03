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
