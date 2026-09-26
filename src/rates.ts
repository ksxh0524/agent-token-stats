// 汇率自动更新：每天从免费汇率源拉一次，折算成 prices.json 里的 rates ——
// 「1 外币 = N ¥」（如 $: 7.03）。界面只负责选显示币种，不再让用户手填比例。
export const RATES_URL = 'https://open.er-api.com/v6/latest/CNY';

/** 界面支持的显示币种 → 符号。基准是 CNY，汇率源返回的是「1 CNY = N 外币」。 */
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', KRW: '₩' };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** 拉取并折算；失败或数据异常返回 null（调用方保留原汇率，不要写坏值） */
export async function fetchRates(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { rates?: Record<string, unknown> };
    const table = json?.rates;
    if (!table || typeof table !== 'object' || table.CNY !== 1) return null;
    const out: Record<string, number> = {};
    for (const [code, sym] of Object.entries(SYMBOLS)) {
      const perCny = table[code];
      if (typeof perCny === 'number' && Number.isFinite(perCny) && perCny > 0) out[sym] = round6(1 / perCny);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
