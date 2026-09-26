// 价格同步：pi 用户配置优先，models.dev 官方目录全量兜底。
//
// 数据源（都是「每百万 token 美元价」，落盘前按 rates['$'] 折 ¥）：
//  - pi 配置（~/.pi/agent/models.json，PI_MODELS_FILE 可覆盖）：用户手填的真实价，最高优先
//  - models.dev 公共目录（https://models.dev/api.json）：官方价，**全量**导入
//  - GitHub 仓库（anomalyco/models.dev）：只补「站点还没构建出来的最新模型」。
//    api.json 就是该仓库的构建产物（provider 213/213、模型数逐一相等），
//    差别只在构建延迟，所以增量拉最近变更的 provider TOML 即可，不做全量。
//
// 合并规则：已有非 0 价格的模型一律不碰（用户手填值永远最高优先）；
// 缺失或全 0 的 key 按候选顺序填入。同一模型多来源先到先得（pi 在前），
// models.dev 内部先按「原厂 provider」排（避免取到中转站价格），再按 provider / id 字典序。
//
// 范围 + 路由：只处理本地实际用过的模型（opts.only），绝不全量导入目录。
// 其中「目录里查不到、又带变体后缀」的名字（deepseek-v4-pro-0731）走 buildModelRoutes
// 登记成别名归一到基名，避免同一模型裂成多行且全都无价。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelPrice, PriceConfig, PriceSource } from './types.ts';
import { normalizeModelName, routeModelName } from './util.ts';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_REPO = 'anomalyco/models.dev';

const GITHUB_API = `https://api.github.com/repos/${MODELS_DEV_REPO}`;
const GITHUB_RAW = `https://raw.githubusercontent.com/${MODELS_DEV_REPO}/HEAD`;

/** 单次 GitHub 追新最多拉取的文件数，防变更风暴打爆请求 */
const GITHUB_MAX_FILES = 80;

export interface PriceSyncCandidate {
  model: string; // 归一化后的模型名（与 prices.json 的 key 同一口径）
  price: ModelPrice; // ¥ / 百万 token
  source: 'pi' | 'models.dev' | 'github';
  rawId: string; // 来源里的原始模型 id（反馈展示用）
  provider: string; // 来源里的 provider 名（反馈展示用）
}

export interface PriceSyncResult {
  filled: PriceSyncCandidate[]; // 本次实际写入的（新增 key + 补上全 0 的 key + 被纠正的自动价）
  skipped: { model: string; price: ModelPrice; source: PriceSyncCandidate['source']; reason: string }[]; // 拿到了价但没写入的
  added: number; // 其中新增的 key 数
  filledZero: number; // 其中把已有全 0 key 填上的数量
  corrected: number; // 其中自动填入的旧值被更好来源纠正的数量
  byProvider: { provider: string; count: number }[]; // 写入来源分布（top 10）
  piConfigured: boolean; // pi 配置文件是否读到
  modelsDevOk: boolean; // models.dev 是否拉取成功
  githubOk: boolean; // GitHub 追新通道是否可用
  githubFiles: number; // GitHub 追新实际解析的文件数
  catalog: number; // 官方目录归一化后的模型总数（仅用于反馈，不代表会写入）
  inScope: number; // 本次纳入同步范围的本地模型数（本地用过的 + 已有配置）
  routed: { variant: string; base: string }[]; // 自动路由到基名的变体（写进 modelAliases）
  dryRun: boolean; // 只算不落盘
}

export interface PriceSyncOptions {
  /** 是否走 GitHub 追新通道（默认开；api.json 已经覆盖到的模型不会重复） */
  github?: boolean;
  /** 只算不落盘，用于预览 */
  dryRun?: boolean;
  /** GitHub 追新回溯窗口，默认 7 天 */
  githubSinceMs?: number;
  /** 只处理这些本地模型（= 本地会话用过的 + prices.json 里已有的）。
   *  必须传：官方目录有七千多个模型，不设范围会把整个目录灌进本地配置。 */
  only?: Iterable<string>;
}

const usd = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** cost 对象提取：models.dev 用 cost（旧结构叫 pricing），字段可能是 snake_case 或 camelCase */
function pickCost(raw: unknown): ModelPrice | null {
  const c = (raw as { cost?: unknown; pricing?: unknown })?.cost ?? (raw as { pricing?: unknown })?.pricing;
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const read = (...keys: string[]): number => {
    for (const k of keys) if (o[k] != null) return usd(o[k]);
    return 0;
  };
  return {
    input: read('input'),
    output: read('output'),
    cacheRead: read('cache_read', 'cacheRead'),
    cacheWrite: read('cache_write', 'cacheWrite'),
  };
}

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
      const cost = pickCost(m);
      if (!id || !cost) continue;
      out.push({
        model: normalizeModelName(id, aliases),
        provider: pname,
        rawId: id,
        price: scale(cost, usdRate),
        source: 'pi',
      });
    }
  }
  return out;
}

/** 美元 × 汇率会带出浮点尾巴（2.5 × 7.2 = 18.000000000000004），落盘和界面都不该出现这种东西 */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function scale(p: ModelPrice, rate: number): ModelPrice {
  return {
    input: round6(p.input * rate),
    output: round6(p.output * rate),
    cacheRead: round6(p.cacheRead * rate),
    cacheWrite: round6(p.cacheWrite * rate),
  };
}

// ---------- 原厂优先排序 ----------
// 同一个模型在目录里常有几十个 provider 报价（例：deepseek-v4-flash 有 73 个），
// 无脑取字典序第一个会拿到中转站的价。这里把「provider 就是模型原厂」的排到最前。
const ORG_ALIASES: Record<string, string[]> = {
  'z-ai': ['zai', 'zhipuai', 'z-ai'],
  'x-ai': ['xai'],
  moonshotai: ['moonshotai', 'moonshot'],
  'meta-llama': ['meta', 'meta-llama'],
  alibaba: ['alibaba', 'qwen', 'dashscope'],
  google: ['google', 'google-vertex', 'google-vertex-anthropic'],
  anthropic: ['anthropic'],
  openai: ['openai'],
  deepseek: ['deepseek'],
  nvidia: ['nvidia'],
  tencent: ['tencent', 'tencent-tokenhub'],
  minimax: ['minimax'],
  stepfun: ['stepfun', 'stepfun-ai'],
  xiaomi: ['xiaomi'],
};

/** 聚合站 / 中转站：价格不代表官方定价，仅在没有原厂候选时兜底 */
const AGGREGATORS = new Set([
  'aihubmix', 'azure', 'bothub', 'chutes', 'deepinfra', 'fireworks-ai', 'freemodel', 'groq', 'helicone',
  'kilo', 'llmgateway', 'nano-gpt', 'novita-ai', 'openrouter', 'opencode', 'opencode-go', 'orcarouter',
  'poe', 'requesty', 'siliconflow', 'togetherai', 'tokengo', 'tokenrouter', 'unorouter', 'venice',
  'vercel', 'wandb', 'xpersona', 'zeldoc',
]);

const PROVIDER_SUFFIX = /-(cn|coding-plan-cn|coding-plan|token-plan-cn|token-plan|plan|anthropic|vertex|bedrock|ai-gateway|workers-ai|cloud|ams|sgp|eu)$/;

/** provider 归一：剥掉区域/套餐后缀（zai-coding-plan → zai、google-vertex → google） */
function canonicalProvider(p: string): string {
  let s = p.trim().toLowerCase();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(PROVIDER_SUFFIX, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 登记在册的原厂 provider（别名展开后的集合）。
 *  不能拿模型 id 的 org 前缀当「是不是原厂」的判据：中转站也会用自己的名字当前缀
 *  （cline-pass/glm-5.3）。org 前缀只用来在「都是原厂」时挑出模型归属的那一家。 */
const ORIGIN_PROVIDERS = new Set(Object.values(ORG_ALIASES).flat().map((a) => a.toLowerCase()));

/** 模型 id 的组织前缀：'openai/gpt-5.6-sol' → 'openai'；无前缀返回 '' */
function orgOf(rawId: string): string {
  const i = rawId.indexOf('/');
  return i > 0 ? rawId.slice(0, i).toLowerCase() : '';
}

/** 排序权重（越小越优先）：
 *  10 = 模型归属的原厂（deepseek 目录下的 deepseek/deepseek-v4-flash）
 *  20 = 其他登记原厂（阿里云也卖 DeepSeek，但价未必等于官方）
 *  30 = 第三方服务商    40 = 聚合 / 中转站 */
function providerRank(provider: string, rawId: string): number {
  const p = canonicalProvider(provider);
  if (ORIGIN_PROVIDERS.has(p)) {
    const org = orgOf(rawId);
    return org && canonicalProvider(org) === p ? 10 : 20;
  }
  return AGGREGATORS.has(p) ? 40 : 30;
}

/** models.dev api.json：providers → models[id].cost（USD / 百万 token，snake_case 字段） */
export function candidatesFromModelsDev(
  raw: unknown,
  aliases: Record<string, string>,
  usdRate: number,
): PriceSyncCandidate[] {
  const out: PriceSyncCandidate[] = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const pname of Object.keys(raw as Record<string, unknown>)) {
    const models = (raw as Record<string, { models?: Record<string, unknown> }>)[pname]?.models;
    if (!models) continue;
    for (const id of Object.keys(models)) {
      const cost = pickCost(models[id]);
      if (!cost) continue;
      out.push({
        model: normalizeModelName(id, aliases),
        provider: pname,
        rawId: id,
        price: scale(cost, usdRate),
        source: 'models.dev',
      });
    }
  }
  // 模型归属原厂 → 其他原厂 → 第三方 → 聚合站；同档按 provider / id 字典序，保证结果稳定不漂移
  out.sort(
    (a, b) =>
      providerRank(a.provider, a.rawId) - providerRank(b.provider, b.rawId) ||
      a.provider.localeCompare(b.provider) ||
      a.rawId.localeCompare(b.rawId),
  );
  return out;
}

// ---------- GitHub 追新（补 api.json 的构建延迟） ----------

/** 极简 TOML [cost] 段解析：只认 input / output / cache_read / cache_write 四个数字 */
export function parseCostToml(text: string): ModelPrice | null {
  const m = /\[cost\]([\s\S]*?)(?:\n\s*\[|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, number> = {};
  for (const line of m[1].split('\n')) {
    const mm = /^\s*([A-Za-z_]+)\s*=\s*(-?[\d_.eE+]+)\s*$/.exec(line.trim());
    if (!mm) continue;
    const v = Number(mm[2].replace(/_/g, ''));
    if (Number.isFinite(v) && v >= 0) out[mm[1]] = v;
  }
  if (!Object.keys(out).length) return null;
  return {
    input: out.input ?? 0,
    output: out.output ?? 0,
    cacheRead: out.cache_read ?? out.cacheRead ?? 0,
    cacheWrite: out.cache_write ?? out.cacheWrite ?? 0,
  };
}

/** providers/<provider>/models/<...>/<id>.toml → { provider, id } */
export function parseProviderModelPath(path: string): { provider: string; id: string } | null {
  const m = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(path);
  if (!m) return null;
  return { provider: m[1], id: m[2] };
}

interface GithubSyncStats {
  ok: boolean;
  files: number;
  candidates: PriceSyncCandidate[];
}

/** 拉取仓库近期变更的 provider TOML，解析出 api.json 还没构建出来的新模型价 */
export async function fetchGithubRecentCandidates(
  aliases: Record<string, string>,
  usdRate: number,
  sinceMs = 7 * 24 * 3600 * 1000,
): Promise<GithubSyncStats> {
  const fail: GithubSyncStats = { ok: false, files: 0, candidates: [] };
  try {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'agent-token-stats' };
    const since = new Date(Date.now() - sinceMs).toISOString();
    // 1) 找到窗口起点之前最后一个 commit 作为 base，再 compare 到 HEAD 一次拿到全部变更文件
    const baseRes = await fetch(`${GITHUB_API}/commits?per_page=1&until=${encodeURIComponent(since)}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!baseRes.ok) return fail;
    const base = (await baseRes.json()) as { sha?: string }[];
    const baseSha = base?.[0]?.sha;
    if (!baseSha) return fail;

    const cmpRes = await fetch(`${GITHUB_API}/compare/${baseSha}...HEAD`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!cmpRes.ok) return fail;
    const cmp = (await cmpRes.json()) as { files?: { filename?: string }[] };
    const paths = (cmp.files ?? [])
      .map((f) => f.filename || '')
      .filter((f) => f.startsWith('providers/') && f.endsWith('.toml'))
      .slice(0, GITHUB_MAX_FILES);
    if (!paths.length) return { ok: true, files: 0, candidates: [] };

    // 2) 逐个 raw 拉取（变更文件通常个位数，最多 GITHUB_MAX_FILES 个）
    const candidates: PriceSyncCandidate[] = [];
    let files = 0;
    const texts = await Promise.all(
      paths.map(async (p) => {
        try {
          const r = await fetch(`${GITHUB_RAW}/${p}`, { signal: AbortSignal.timeout(10000) });
          return r.ok ? await r.text() : null;
        } catch {
          return null;
        }
      }),
    );
    paths.forEach((path, i) => {
      const text = texts[i];
      const pm = parseProviderModelPath(path);
      if (!text || !pm) return;
      const cost = parseCostToml(text);
      if (!cost) return;
      files++;
      candidates.push({
        model: normalizeModelName(pm.id, aliases),
        provider: pm.provider,
        rawId: pm.id,
        price: scale(cost, usdRate),
        source: 'github',
      });
    });
    return { ok: true, files, candidates };
  } catch {
    return fail;
  }
}

const isZeroPrice = (p: ModelPrice) => !p.input && !p.output && !p.cacheRead && !p.cacheWrite;

/** merge 阶段能确定的字段；来源可用性等由 syncPrices 补齐 */
export type MergeOutcome = Pick<
  PriceSyncResult,
  'filled' | 'skipped' | 'added' | 'filledZero' | 'corrected' | 'byProvider' | 'dryRun'
>;

/** 严格比较：浮点尾巴（31.680000000000003 vs 31.68）算「不同」，好让自动来源的值被归一化重写；
 *  手填值靠 isAutoSource 拦截，不受这里影响。 */
const samePrice = (a: ModelPrice, b: ModelPrice) =>
  a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/** 自动填的来源：只有这类价格允许被更好的来源纠正。
 *  没有来源记录的（历史数据 / 界面手填）一律按手工处理 —— 宁可不覆盖，也不动用户填过的值。 */
const isAutoSource = (s: PriceSource | undefined) => s === 'models.dev' || s === 'github';

/** 合并候选到现有配置：先到先得（调用方保证 pi 候选在前）。
 *  - 无记录 / 全 0 的 key：直接填入
 *  - 已有非 0 价：来源是 manual / pi → 保留；来源是自动的 → 允许被更好的来源纠正（中转站价 → 原厂价）
 *  - 免费模型（价全 0）只登记一次，不重复「补零」 */
export function mergePriceCandidates(
  cfg: PriceConfig,
  candidates: PriceSyncCandidate[],
): { cfg: PriceConfig; result: MergeOutcome } {
  const prices = { ...cfg.prices };
  const priceSources: Record<string, PriceSource> = { ...(cfg.priceSources || {}) };
  const seen = new Set<string>();
  const filled: PriceSyncCandidate[] = [];
  const skipped: PriceSyncResult['skipped'] = [];
  let added = 0;
  let filledZero = 0;
  let corrected = 0;
  for (const c of candidates) {
    if (seen.has(c.model)) continue; // 同一模型多来源：先注册的优先
    seen.add(c.model);
    const cur = prices[c.model];
    const curSrc = priceSources[c.model];

    if (cur && !isZeroPrice(cur)) {
      if (!isAutoSource(curSrc)) {
        skipped.push({ model: c.model, price: c.price, source: c.source, reason: '已有手填/pi 价格，保持不动' });
        continue;
      }
      if (samePrice(cur, c.price)) continue; // 已是同一个价，不写盘
      prices[c.model] = { ...c.price };
      priceSources[c.model] = c.source;
      filled.push(c);
      corrected++;
      continue;
    }
    if (cur && isZeroPrice(cur) && isZeroPrice(c.price)) {
      priceSources[c.model] = c.source; // 免费模型：只补来源标记，避免每次同步都当成「待填」
      continue;
    }
    prices[c.model] = { ...c.price };
    priceSources[c.model] = c.source;
    filled.push(c);
    if (cur) filledZero++;
    else added++;
  }
  const counts = new Map<string, number>();
  for (const f of filled) counts.set(f.provider, (counts.get(f.provider) || 0) + 1);
  const byProvider = [...counts.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
    .slice(0, 10);
  const cfgOut: PriceConfig = { ...cfg, prices, priceSources };
  return { cfg: cfgOut, result: { filled, skipped, added, filledZero, corrected, byProvider, dryRun: false } };
}

/** 变体名自动路由：本地出现过、但既不认识也拿不到价的名字
 *  （deepseek-v4-pro-0713 / gpt-5.6-sol-preview / xxx-thinking），
 *  按后缀正则剥一层层往回找已知模型名，命中就登记成别名 —— 扫描时直接归一到基名，
 *  于是价格、聚合、会话归属全都跟着走，不会裂成多行。
 *
 *  约束：
 *   - 只处理「没价格、也不在目标集合里」的名字；已有 key（含 models.dev 给的免费 0 价）一律不动
 *   - 已经配过别名的名字跳过（用户的手动映射优先）
 *   - 目标集合 = 配置里已有价格的模型名（含本次同步刚填进去的），不认目录全集 */
export function buildModelRoutes(
  locals: Iterable<string>,
  known: Iterable<string>,
  aliases: Record<string, string> = {},
): { variant: string; base: string }[] {
  const knownSet = known instanceof Set ? (known as Set<string>) : new Set(known);
  const out: { variant: string; base: string }[] = [];
  const seen = new Set<string>();
  for (const raw of locals) {
    const name = (raw || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (aliases[name] || knownSet.has(name)) continue; // 已配别名 / 本来就有价 → 不用路由
    const base = routeModelName(name, knownSet);
    if (base && base !== name) out.push({ variant: name, base });
  }
  return out;
}

export function piModelsFile(): string {
  return process.env.PI_MODELS_FILE || join(homedir(), '.pi', 'agent', 'models.json');
}

export async function fetchModelsDev(): Promise<unknown | null> {
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15000) });
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

/** 同步主流程：读三个源 → 候选合并 → 有变化才落盘。供 /api/prices/sync 与定时任务调用。
 *  只填「本地用过的模型」（opts.only），绝不全量导入官方目录。 */
export async function syncPrices(
  cfg: PriceConfig,
  save: (cfg: PriceConfig) => Promise<void>,
  opts: PriceSyncOptions = {},
): Promise<PriceSyncResult> {
  const usdRate = cfg.rates?.['$'] && cfg.rates['$'] > 0 ? cfg.rates['$'] : 7.2;
  const aliases = cfg.modelAliases || {};

  const [piRaw, modelsDevRaw, gh] = await Promise.all([
    readPiModelsRaw(),
    fetchModelsDev(),
    opts.github === false
      ? Promise.resolve({ ok: false, files: 0, candidates: [] } as GithubSyncStats)
      : fetchGithubRecentCandidates(aliases, usdRate, opts.githubSinceMs),
  ]);

  const only = new Set(opts.only ?? []);
  const inScope = (m: string) => only.has(m);
  const devAll = candidatesFromModelsDev(modelsDevRaw, aliases, usdRate);
  const devCandidates = devAll.filter((c) => inScope(c.model));
  const piCandidates = candidatesFromPiConfig(piRaw, aliases, usdRate).filter((c) => inScope(c.model));

  // 顺序 = 优先级：pi 手填 > 官方目录 > GitHub 追新。
  // 目录里已有的模型先注册，GitHub 同名的自然被跳过，只补目录还没构建出来的新模型。
  const catalog = new Set(devAll.map((c) => c.model));
  const ghCandidates = gh.candidates.filter((c) => inScope(c.model) && !catalog.has(c.model));

  const { cfg: merged, result } = mergePriceCandidates(cfg, [...piCandidates, ...devCandidates, ...ghCandidates]);

  // 变体路由放在合并之后：目标集合用「合并后的价格表」，本次刚填进去的模型也能当基名，
  // 于是 deepseek-v4-pro-0731 这种名字在同一个同步周期里就能挂到刚拿到的 deepseek-v4-pro 上。
  const routes = buildModelRoutes(only, Object.keys(merged.prices), aliases);
  const mergedCfg: PriceConfig = routes.length
    ? { ...merged, modelAliases: { ...aliases, ...Object.fromEntries(routes.map((r) => [r.variant, r.base])) } }
    : merged;

  const out: PriceSyncResult = {
    ...result,
    piConfigured: piRaw != null,
    modelsDevOk: modelsDevRaw != null,
    githubOk: gh.ok,
    githubFiles: gh.files,
    catalog: catalog.size,
    inScope: only.size,
    routed: routes,
    dryRun: !!opts.dryRun,
  };

  // 有新价格、或者新登记了路由别名，才落盘（dryRun 一律不写）
  if ((out.filled.length || routes.length) && !opts.dryRun) await save(mergedCfg);
  return out;
}
