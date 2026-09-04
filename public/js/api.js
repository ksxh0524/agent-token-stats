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

export function saveConfig(cfg) {
  return fetchJSON('/api/prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}
