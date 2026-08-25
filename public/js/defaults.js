// 官方默认单价（每百万 token，¥ 口径；美元价按 7.2 折算）
const USD2CNY = 7.2;
const usd = (n) => n * USD2CNY;

export const DEFAULTS = {
  'gpt-5.6-terra': { input: usd(2.0), output: usd(12.0), cacheRead: usd(0.2), cacheWrite: usd(2.5) },
  'gpt-5.6-sol': { input: usd(5.0), output: usd(30.0), cacheRead: usd(0.5), cacheWrite: usd(6.25) },
  'gpt-5.6-luna': { input: usd(0.2), output: usd(1.2), cacheRead: usd(0.02), cacheWrite: usd(0.25) },
  'deepseek-v4-flash': { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 2, output: 4, cacheRead: 0.04, cacheWrite: 0 },
  'glm-5.2': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'grok-4.5': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'ark-code-latest': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function zeroPrice() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
