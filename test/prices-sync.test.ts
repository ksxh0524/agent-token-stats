// 价格同步的纯函数测试：候选提取 + 合并规则（不发真实网络请求）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelRoutes,
  candidatesFromPiConfig,
  candidatesFromModelsDev,
  mergePriceCandidates,
  parseCostToml,
  parseProviderModelPath,
} from '../src/prices-sync.ts';
import { routeModelName } from '../src/util.ts';
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

test('candidatesFromModelsDev：cost 字段（models.dev 现用字段，snake_case）+ provider 排序确定性', () => {
  const raw = {
    'zzz-provider': { models: { 'deepseek-v4-flash': { cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } } } },
    'aaa-provider': { models: { 'deepseek-v4-flash': { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
    'empty-provider': { models: {} },
  };
  const cands = candidatesFromModelsDev(raw, {}, R);
  // 两个都不是原厂、同档 → 按 provider 字典序，aaa 在前
  assert.equal(cands.length, 2);
  assert.equal(cands[0].provider, 'aaa-provider');
  assert.ok(Math.abs(cands[0].price.input - R) < 1e-9);
});

test('candidatesFromModelsDev：兼容旧 pricing 字段（不忽略即可）', () => {
  const raw = { p: { models: { m1: { pricing: { input: 1, output: 2 } } } } };
  const cands = candidatesFromModelsDev(raw, {}, R);
  assert.equal(cands.length, 1);
  assert.ok(Math.abs(cands[0].price.input - R) < 1e-9);
});

test('candidatesFromModelsDev：原厂 provider 排在聚合/中转站之前', () => {
  const raw = {
    'nano-gpt': { models: { 'deepseek/deepseek-v4-flash': { cost: { input: 0.098, output: 0.196 } } } },
    deepseek: { models: { 'deepseek/deepseek-v4-flash': { cost: { input: 0.14, output: 0.28 } } } },
    tokengo: { models: { 'deepseek/deepseek-v4-flash': { cost: { input: 0.2, output: 0.4 } } } },
  };
  const cands = candidatesFromModelsDev(raw, {}, R);
  assert.equal(cands[0].provider, 'deepseek', '原厂应排最前（字典序 deepseek 也在前，但这里靠 rank 保证）');
  assert.ok(Math.abs(cands[0].price.input - 0.14 * R) < 1e-9);
  // 聚合站沉底（同档按字典序：nano-gpt < tokengo，所以 tokengo 最后）
  assert.equal(cands[cands.length - 1].provider, 'tokengo');
});

test('candidatesFromModelsDev：套餐/区域后缀的 provider 也算原厂', () => {
  const raw = {
    'zai-coding-plan': { models: { 'z-ai/glm-5.3': { cost: { input: 0.6, output: 2.2 } } } },
    'some-hub': { models: { 'z-ai/glm-5.3': { cost: { input: 0.4, output: 1.6 } } } },
  };
  const cands = candidatesFromModelsDev(raw, {}, R);
  assert.equal(cands[0].provider, 'zai-coding-plan');
});

test('candidatesFromModelsDev：中转站用自己的名字当 org 前缀，不能冒充原厂', () => {
  const raw = {
    'cline-pass': { models: { 'cline-pass/glm-5.3': { cost: { input: 1.4, output: 4.4 } } } },
    zai: { models: { 'glm-5.3': { cost: { input: 0.6, output: 2.2 } } } },
  };
  const cands = candidatesFromModelsDev(raw, {}, R);
  assert.equal(cands[0].provider, 'zai', '智谱原厂应排在 cline-pass 之前');
});

test('mergePriceCandidates：自动来源的价可被纠正，手填 / 无来源记录的一律不动', () => {
  const cfg: PriceConfig = {
    currency: '¥',
    rates: { $: R },
    prices: {
      auto1: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
      manual1: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
      legacy: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
    },
    modelAliases: {},
    priceSources: { auto1: 'models.dev', manual1: 'manual' },
  };
  const mk = (m: string) => ({
    model: m,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    source: 'models.dev' as const,
    rawId: m,
    provider: 'origin',
  });
  const { cfg: out, result } = mergePriceCandidates(cfg, [mk('auto1'), mk('manual1'), mk('legacy')]);

  assert.equal(out.prices.auto1.input, 1, '自动来源 → 允许纠正（中转站价 → 原厂价）');
  assert.equal(out.prices.manual1.input, 9, 'manual → 不动');
  assert.equal(out.prices.legacy.input, 9, '无来源记录 → 按手工保守处理');
  assert.equal(result.corrected, 1);
  assert.equal(out.priceSources?.auto1, 'models.dev');
  assert.equal(out.priceSources?.auto1 && out.priceSources?.manual1, 'manual');
});

test('mergePriceCandidates：免费模型（价全 0）只补来源标记，不反复「补零」', () => {
  const cfg: PriceConfig = {
    currency: '¥',
    rates: { $: R },
    prices: { 'free-x': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    modelAliases: {},
  };
  const cand = {
    model: 'free-x',
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source: 'models.dev' as const,
    rawId: 'free-x',
    provider: 'openrouter',
  };
  const first = mergePriceCandidates(cfg, [cand]);
  assert.equal(first.result.filled.length, 0, '全 0 价不算填充');
  assert.equal(first.cfg.priceSources?.['free-x'], 'models.dev');
  const second = mergePriceCandidates(first.cfg, [cand]);
  assert.equal(second.result.filled.length, 0, '第二次同步不应再把它当待填项');
});

test('candidatesFromModelsDev：同是原厂时，模型归属的那家优先', () => {
  const raw = {
    'alibaba-cn': { models: { 'deepseek/deepseek-v4-flash': { cost: { input: 1.008, output: 2.016 } } } },
    deepseek: { models: { 'deepseek/deepseek-v4-flash': { cost: { input: 1.4, output: 2.8 } } } },
  };
  const cands = candidatesFromModelsDev(raw, {}, R);
  assert.equal(cands[0].provider, 'deepseek', 'deepseek 官方应排在同样卖它的阿里云前面');
});

test('parseCostToml / parseProviderModelPath：GitHub 追新的最小解析', () => {
  const toml = [
    'name = "GLM 5.3"',
    'family = "glm"',
    '',
    '[cost]',
    'input = 1_024.5',
    'output = 25',
    'cache_read = 0.5',
    'cache_write = 6.25',
    '',
    '[limit]',
    'context = 200_000',
  ].join('\n');
  const cost = parseCostToml(toml)!;
  assert.ok(cost);
  assert.equal(cost.input, 1024.5); // 下划线数字要还原
  assert.equal(cost.output, 25);
  assert.equal(cost.cacheRead, 0.5);
  assert.equal(cost.cacheWrite, 6.25);
  assert.equal(parseCostToml('name = "no cost"\n[limit]\ncontext = 100'), null);

  assert.deepEqual(parseProviderModelPath('providers/kilo/models/nvidia/nemotron-3.5-lightning.toml'), {
    provider: 'kilo',
    id: 'nvidia/nemotron-3.5-lightning',
  });
  assert.equal(parseProviderModelPath('providers/kilo/logo.svg'), null);
});

test('mergePriceCandidates：只填全 0 模型，手填非 0 不碰，pi 优先于 models.dev', () => {
  const cfg = baseCfg();
  const piCands = candidatesFromPiConfig(
    { providers: { P: { models: [{ id: 'free-model', cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0 } }] } } },
    {},
    R,
  );
  const devCands = candidatesFromModelsDev(
    { openai: { models: { 'gpt-5.6-terra': { cost: { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 } } } } },
    {},
    R,
  );
  const { cfg: merged, result } = mergePriceCandidates(cfg, [...piCands, ...devCands]);

  // free-model 全 0 → 被 pi 候选填入
  assert.equal(result.filled.length, 1);
  assert.equal(result.filled[0].model, 'free-model');
  assert.equal(result.filledZero, 1); // 已有 key、全 0 → 算「补零」不算新增
  assert.equal(result.added, 0);
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

test('routeModelName：后缀变体路由到基名，不识别就返回空', () => {
  const known = new Set([
    'deepseek-v4-pro',
    'deepseek-v4-pro-free',
    'glm-5.3-flash',
    'qwen3.8-max',
    'gpt-5.6-sol',
    'ark-code-latest',
  ]);

  // 用户实际遇到的形状：基名后面挂日期戳 / 预览标记 / 思考模式
  assert.equal(routeModelName('deepseek-v4-pro-0731', known), 'deepseek-v4-pro');
  assert.equal(routeModelName('deepseek-v4-pro-0713', known), 'deepseek-v4-pro');
  assert.equal(routeModelName('deepseek-v4-pro-20260731', known), 'deepseek-v4-pro');
  assert.equal(routeModelName('deepseek-v4-pro-preview', known), 'deepseek-v4-pro');
  assert.equal(routeModelName('deepseek-v4-pro-thinking', known), 'deepseek-v4-pro');
  assert.equal(routeModelName('gpt-5.6-sol-high', known), 'gpt-5.6-sol');
  assert.equal(routeModelName('GLM-5.3-Flash-V2', known), 'glm-5.3-flash'); // 大小写不敏感

  // -free 保留：免费模型先归到免费基名，不会串到收费基名
  assert.equal(routeModelName('deepseek-v4-pro-free-0713', known), 'deepseek-v4-pro-free');
  // 多层后缀：先剥 -preview 命中免费基名，不再继续剥到收费的
  assert.equal(routeModelName('deepseek-v4-pro-free-0713-preview', known), 'deepseek-v4-pro-free');

  // 本来就认识的基名不路由（自己路由到自己没意义）
  assert.equal(routeModelName('deepseek-v4-pro', known), '');
  // 后缀不是噪音（-pro / -max / -flash 是模型身份）→ 不猜
  assert.equal(routeModelName('qwen3.8-max-ultra', known), '');
  // 剥完也没命中已知模型 → 空
  assert.equal(routeModelName('some-unknown-model-0713', known), '');
  assert.equal(routeModelName('', known), '');
});

test('buildModelRoutes：只路由没价、没别名的本地模型，目标必须已存在', () => {
  const known = ['deepseek-v4-pro', 'deepseek-v4-pro-free', 'glm-5.3-flash'];
  const aliases = { 'glm-5.3-flash-free': 'glm-5.3-flash' };
  const locals = [
    'deepseek-v4-pro', // 基名本身，跳过
    'deepseek-v4-pro-0731', // 变体 → 路由
    'deepseek-v4-pro-free-0713', // 免费变体 → 路由到免费基名
    'glm-5.3-flash-free', // 已配别名，跳过
    'glm-5.3-flash-free-0713', // 带后缀：剥一层 → glm-5.3-flash-free（不在 known）… 继续剥不了 → 不猜
    'brand-new-model', // 认不出来
    'deepseek-v4-pro-0731', // 重复项去重
  ];
  const routes = buildModelRoutes(locals, known, aliases);
  assert.deepEqual(routes, [
    { variant: 'deepseek-v4-pro-0731', base: 'deepseek-v4-pro' },
    { variant: 'deepseek-v4-pro-free-0713', base: 'deepseek-v4-pro-free' },
  ]);
});

test('buildModelRoutes：先登记的变体不吃掉后面的（一次性算完，不自我递归）', () => {
  // x-v2 与 x-v2-preview 都在本地出现，基名 x 有价 → 两个都归到 x，而不是后者归到前者
  const routes = buildModelRoutes(['x-v2-preview', 'x-v2'], ['x'], {});
  assert.deepEqual(new Set(routes.map((r) => r.base)), new Set(['x']));
  assert.equal(routes.length, 2);
});
