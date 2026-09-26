// API 封装：统一错误处理，供断线横幅使用

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// rev = 上次拿到的数据版本号；服务端发现没变化只回 {unchanged:true}（几百字节），
// 避免每 30s 全量拉几 MB 的会话大载荷
export function getData(rev) {
  return fetchJSON('/api/data' + (rev ? `?rev=${encodeURIComponent(rev)}` : ''));
}

// allowEmpty：只有「清空」按钮才允许把 config 里的 prices 清空，
// 其余保存路径服务端会拒绝空配置（页面数据未就绪时点保存不该把整份配置抹了）
export function saveConfig(cfg, { allowEmpty = false } = {}) {
  return fetchJSON('/api/prices' + (allowEmpty ? '?allowEmpty=1' : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}

// 从 pi 配置 + models.dev 同步价格（后端合并规则：只填全 0 的模型，手填值不动）
export function syncPrices() {
  return fetchJSON('/api/prices/sync', { method: 'POST' });
}
