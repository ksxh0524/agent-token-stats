// 价格同步的纯函数测试：候选提取 + 合并规则（不发真实网络请求）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFromPiConfig,
  candidatesFromModelsDev,
  mergePriceCandidates,
} from '../src/prices-sync.ts';
import type { PriceConfig } from '../src/types.ts';

const R = 7.2; // 测试用美元汇率

const baseCfg = (): PriceConfig => ({
  currency: '¥',
  rates: { $: R },
  prices: {
    'gpt-5.6-terra': { input: 3, output: 18, cacheRead: 0.3, cacheWrite: 3.75 }, // 用户手填，非 0
    'free-model': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 全 0 = 未配置
  },
  modelAliases: { 'org/custom-name': 'aliased-model' },
});

test('candidatesFromPiConfig：提取 cost 并按汇率折 ¥，无 cost 的模型跳过', () => {
  const raw = {
    providers: {
      'Tokeness-OpenAI': {
        models: [
          { id: 'gpt-5.6-terra', cost: { input: 0.42, output: 2.52, cacheRead: 0.042, cacheWrite: 0.525 } },
          { id: 'gpt-5.6-sol' }, // 没有 cost 字段 → 跳过
          { id: 'org/custom-name', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    },
  };
  const cands = candidatesFromPiConfig(raw, baseCfg().modelAliases, R);
  assert.equal(cands.length, 2);
  const terra = cands.find((c) => c.model === 'gpt-5.6-terra')!;
  assert.ok(terra);
  assert.equal(terra.source, 'pi');
  assert.equal(terra.provider, 'Tokeness-OpenAI');
  assert.ok(Math.abs(terra.price.input - 0.42 * R) < 1e-9);
  assert.ok(Math.abs(terra.price.output - 2.52 * R) < 1e-9);
  // 别名映射生效：org/custom-name → aliased-model
  const aliased = cands.find((c) => c.model === 'aliased-model')!;
  assert.ok(aliased, '别名映射后的模型名应作为 key');
});

test('candidatesFromModelsDev：snake_case pricing 字段提取 + provider 排序确定性', () => {
  const raw = {
    'zzz-provider': { models: { 'deepseek-v4-flash': { pricing: { input: 0.14, output: 0.28, cache_read: 0.0028 } } } },
    'aaa-provider': { models: { 'deepseek-v4-flash': { pricing: { input: 1, output: 2, cache_read: 0.1 } } } },
    'empty-provider': { models: {} },
  };
  const cands = candidatesFromModelsDev(raw, {}, R);
  // aaa-provider 排在前面（sort 保证确定性），同模型先到先得
  assert.equal(cands.length, 2);
  assert.equal(cands[0].provider, 'aaa-provider');
  assert.ok(Math.abs(cands[0].price.input - R) < 1e-9);
});

test('mergePriceCandidates：只填全 0 模型，手填非 0 不碰，pi 优先于 models.dev', () => {
  const cfg = baseCfg();
  const piCands = candidatesFromPiConfig(
    { providers: { P: { models: [{ id: 'free-model', cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0 } }] } } },
    {},
    R,
  );
  const devCands = candidatesFromModelsDev(
    { openai: { models: { 'gpt-5.6-terra': { pricing: { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 } } } } },
    {},
    R,
  );
  const { cfg: merged, result } = mergePriceCandidates(cfg, [...piCands, ...devCands]);

  // free-model 全 0 → 被 pi 候选填入
  assert.equal(result.filled.length, 1);
  assert.equal(result.filled[0].model, 'free-model');
  assert.ok(Math.abs(merged.prices['free-model'].input - 0.5 * R) < 1e-9);

  // gpt-5.6-terra 已有手填价 → skip，值不变
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].model, 'gpt-5.6-terra');
  assert.equal(merged.prices['gpt-5.6-terra'].input, 3);
});

test('mergePriceCandidates：同模型多来源只有第一个生效', () => {
  const cfg = baseCfg();
  const c1 = { model: 'm1', price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, source: 'pi' as const, rawId: 'm1', provider: 'P' };
  const c2 = { model: 'm1', price: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }, source: 'models.dev' as const, rawId: 'm1', provider: 'Q' };
  const { cfg: merged, result } = mergePriceCandidates(cfg, [c1, c2]);
  assert.equal(result.filled.length, 1);
  assert.equal(merged.prices.m1.input, 1);
});
