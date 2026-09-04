// 价格同步：pi 用户配置优先，models.dev 官方价兜底。
//
// 两个来源的价格都是「每百万 token 美元价」，统一按 rates['$'] 折成 ¥ 落盘。
//  - pi 配置（~/.pi/agent/models.json，PI_MODELS_FILE 可覆盖）：用户手填的中转站真实价，最高优先
//  - models.dev 公共目录（https://models.dev/api.json）：官方价，补 pi 没配 cost 的模型
//
// 合并规则：只针对「整模型价格全 0」（= 未配置）的模型写入；任何已有非 0 价格的
// 模型不碰（用户手填值永远最高优先）。同一模型多个来源先到先得（pi 先于 models.dev）。
// 模型名与 prices.json 的 key 同一口径（normalizeModelName 归一化）。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelPrice, PriceConfig } from './types.ts';
import { normalizeModelName } from './util.ts';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface PriceSyncCandidate {
  model: string; // 归一化后的模型名（与 prices.json 的 key 同一口径）
  price: ModelPrice; // ¥ / 百万 token
  source: 'pi' | 'models.dev';
  rawId: string; // 来源里的原始模型 id（反馈展示用）
  provider: string; // 来源里的 provider 名（反馈展示用）
}

export interface PriceSyncResult {
  filled: PriceSyncCandidate[]; // 本次实际写入的
  skipped: { model: string; price: ModelPrice; source: PriceSyncCandidate['source']; reason: string }[]; // 拿到了价但没写入的
  piConfigured: boolean; // pi 配置文件是否读到
  modelsDevOk: boolean; // models.dev 是否拉取成功
}

const usd = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** pi 的 models.json：providers.<name>.models[].cost（USD / 百万 token） */
export function candidatesFromPiConfig(
  raw: unknown,
  aliases: Record<string, string>,
  usdRate: number,
): PriceSyncCandidate[] {
  const out: PriceSyncCandidate[] = [];
  const providers = (raw as { providers?: Record<string, unknown> })?.providers;
  if (!providers || typeof providers !== 'object') return out;
  for (const [pname, pv] of Object.entries(providers as Record<string, unknown>)) {
    const models = (pv as { models?: unknown })?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      const id = typeof (m as { id?: unknown })?.id === 'string' ? (m as { id: string }).id : '';
      const c = (m as { cost?: Record<string, unknown> })?.cost;
      if (!id || !c || typeof c !== 'object') continue;
      out.push({
        model: normalizeModelName(id, aliases),
        provider: pname,
        rawId: id,
        price: {
          input: usd(c.input) * usdRate,
          output: usd(c.output) * usdRate,
          cacheRead: usd(c.cacheRead) * usdRate,
          cacheWrite: usd(c.cacheWrite) * usdRate,
        },
        source: 'pi',
      });
    }
  }
  return out;
}

/** models.dev api.json：providers → models[id].pricing（USD / 百万 token，snake_case 字段） */
export function candidatesFromModelsDev(
  raw: unknown,
  aliases: Record<string, string>,
  usdRate: number,
): PriceSyncCandidate[] {
  const out: PriceSyncCandidate[] = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const pname of Object.keys(raw as Record<string, unknown>).sort()) {
    const models = (raw as Record<string, { models?: Record<string, { pricing?: Record<string, unknown> }> }>)[
      pname
    ]?.models;
    if (!models) continue;
    for (const id of Object.keys(models).sort()) {
      const pr = models[id]?.pricing;
      if (!pr) continue;
      out.push({
        model: normalizeModelName(id, aliases),
        provider: pname,
        rawId: id,
        price: {
          input: usd(pr.input) * usdRate,
          output: usd(pr.output) * usdRate,
          cacheRead: usd(pr.cache_read) * usdRate,
          cacheWrite: usd(pr.cache_write) * usdRate,
        },
        source: 'models.dev',
      });
    }
  }
  return out;
}

const isZeroPrice = (p: ModelPrice) => !p.input && !p.output && !p.cacheRead && !p.cacheWrite;

/** 合并候选到现有配置：先到先得（调用方保证 pi 候选在前），只填整模型全 0 的 */
export function mergePriceCandidates(
  cfg: PriceConfig,
  candidates: PriceSyncCandidate[],
): { cfg: PriceConfig; result: PriceSyncResult } {
  const prices = { ...cfg.prices };
  const seen = new Set<string>();
  const filled: PriceSyncCandidate[] = [];
  const skipped: PriceSyncResult['skipped'] = [];
  for (const c of candidates) {
    if (seen.has(c.model)) continue; // 同一模型多个来源：pi 先注册，models.dev 不再覆盖
    seen.add(c.model);
    const cur = prices[c.model];
    if (cur && !isZeroPrice(cur)) {
      skipped.push({ model: c.model, price: c.price, source: c.source, reason: '已有非 0 价格，保持手填值' });
      continue;
    }
    prices[c.model] = { ...c.price };
    filled.push(c);
  }
  return { cfg: { ...cfg, prices }, result: { filled, skipped, piConfigured: false, modelsDevOk: false } };
}

export function piModelsFile(): string {
  return process.env.PI_MODELS_FILE || join(homedir(), '.pi', 'agent', 'models.json');
}

export async function fetchModelsDev(): Promise<unknown | null> {
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 读 pi 配置文件；读不到返回 null（没装 pi / 文件坏） */
export async function readPiModelsRaw(fp: string = piModelsFile()): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(fp, 'utf8'));
  } catch {
    return null;
  }
}

/** 同步主流程：读两个源 → 候选合并 → 有变化才落盘。供 /api/prices/sync 调用 */
export async function syncPrices(cfg: PriceConfig, save: (cfg: PriceConfig) => Promise<void>): Promise<PriceSyncResult> {
  const usdRate = cfg.rates?.['$'] && cfg.rates['$'] > 0 ? cfg.rates['$'] : 7.2;
  const aliases = cfg.modelAliases || {};

  const [piRaw, modelsDevRaw] = await Promise.all([readPiModelsRaw(), fetchModelsDev()]);
  const candidates = [
    ...candidatesFromPiConfig(piRaw, aliases, usdRate),
    ...candidatesFromModelsDev(modelsDevRaw, aliases, usdRate),
  ];
  const { cfg: merged, result } = mergePriceCandidates(cfg, candidates);
  result.piConfigured = piRaw != null;
  result.modelsDevOk = modelsDevRaw != null;

  if (result.filled.length) await save(merged);
  return result;
}
