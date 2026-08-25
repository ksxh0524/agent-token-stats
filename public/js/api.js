// API 封装：统一错误处理，供断线横幅使用

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function getData() {
  return fetchJSON('/api/data');
}

export function saveConfig(cfg) {
  return fetchJSON('/api/prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}
