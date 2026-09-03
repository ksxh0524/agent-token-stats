// 集中状态 + UI 偏好持久化。
// 注意：价格 / 汇率 / 别名等配置以服务端 prices.json 为唯一事实源，
// localStorage 只存界面偏好（tab、窗口、币种符号等），避免双写互踩。

const PREF_KEY = 'pits-prefs-v2';

export const state = {
  data: null, // ApiData
  source: 'pi', // pi | opencode（两个 tab，数据分开）
  workspace: 'ALL',
  search: '',
  win: null, // {from, to}；首次加载后默认近 30 天
  auto: false,
  timer: null,
  currency: '¥', // 仅影响显示
  sort: {
    ws: { key: 'totalTokens', dir: -1 },
    sess: { key: 'totalTokens', dir: -1 },
    model: { key: 'totalTokens', dir: -1 },
  },
  status: 'loading', // loading | ok | error
  lastError: '',
};

export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (p.source === 'pi' || p.source === 'opencode') state.source = p.source;
    if (typeof p.workspace === 'string') state.workspace = p.workspace;
    if (p.currency) state.currency = p.currency;
    if (typeof p.auto === 'boolean') state.auto = p.auto;
    // 时间窗口不持久化：每次打开都按「今天」重算近 3 天
  } catch {
    /* 忽略坏数据 */
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        source: state.source,
        workspace: state.workspace,
        currency: state.currency,
        auto: state.auto,
      }),
    );
  } catch {
    /* 存不下就算了 */
  }
}
