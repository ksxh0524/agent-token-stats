# agent-token-stats

> Local dashboard for coding-agent token usage — supports **pi** ([badlogic/pi-mono](https://github.com/badlogic/pi-mono)) and **opencode** as data sources, with breakdowns by **source / workspace / session / day / model / provider**.

[中文](./README.zh-CN.md) | **English**

[![Node >=22.6](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![No build – ES modules](https://img.shields.io/badge/frontend-zero--build-orange)](#project-structure)

Zero runtime dependencies (only devDependencies: `typescript` / `prettier`; opencode uses the built-in `node:sqlite`). Frontend is zero-build native ES modules. Scans hundreds of sessions in seconds with persistent disk cache.

---

## Features

- **Dual sources, strictly isolated** — `pi` (`~/.pi/agent/sessions/*.jsonl`) and `opencode` (`~/.local/share/opencode/opencode.db`) are scanned separately; UI tabs never mix data.
- **Rich dimensions** — workspace total, per-model, model detail (with bar chart + sortable table), per-provider, session detail.
- **Time window** — default **last 3 days** in `Asia/Shanghai` timezone; switch 7/30/90 days or pick a custom range. The window filters every dimension.
- **Cost model** — per-million-token price stored in **¥**; display currency is converted via configurable rates. `actual` = provider-recorded `usage.cost.total`, `estimated` = price×tokens fallback. Cost is resolved at **model × day** granularity so all views stay consistent.
- **Model normalization** — strips org prefix (`deepseek-ai/`, `nvidia/`), lowercases, colon→hyphen, with an editable alias map.
- **Fast scanning** — line-level pre-filter (skip `JSON.parse` for pure text rows) + 8-way parallel parsing + disk cache keyed by `mtime:size` + alias hash. Incremental in-memory refresh + 2s request coalescing for `/api/data`.

## Requirements

- Node.js **>= 22.6** (uses `--experimental-strip-types` to run TypeScript directly without a build step).

## Quick Start

### For humans (opens browser)

```bash
./start.command        # double-click also works; opens http://localhost:32022
./stop.command
```

### For agents / scripts (no browser popup)

```bash
./manager.sh start            # detached; returns only after /health is OK
./manager.sh stop             # 3-layer kill: PID file → process match → port holder
./manager.sh restart          # use after editing backend code
./manager.sh status           # exit code: 0=running  3=not running  4=alive but /health failed
./manager.sh status --json    # one-line JSON for parsing
```

`start.command` / `stop.command` are thin wrappers around `manager.sh` (`manager.command` is a compat symlink) with `--open`. `manager.sh` double-forks (perl `fork+setsid` fallback on macOS) so the server survives the caller.

### npm equivalents

```bash
npm start              # PORT defaults to 32022, override via env
npm run dev            # --watch mode
npm run typecheck      # tsc --noEmit
npm test               # node:test
npm run fmt            # prettier
```

### Environment overrides

| Variable | Default | Description |
|---|---|---|
| `PORT` | `32022` | HTTP listen port |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | pi sessions directory |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | opencode SQLite path (opened read-only) |
| `PRICES_FILE` | `./prices.json` | price/alias config file |
| `PI_SCAN_CACHE` | `./.cache/pi-scan-cache.json` | pi disk-cache path |

> `prices.json` and `.cache/` are gitignored. See `AGENTS.md` for the `PARSER_VERSION` bump rule when changing parsing logic.

## UI Guide

Single-page, top-to-bottom layout. A **pi / opencode** tab at the top switches data source.

- **Overview cards** — totals, active time range, workspace filter, session search
- **Workspace totals** — click a row to filter
- **By model / Model detail / By provider** — bar chart + sortable table (with total row); model detail supports sorting on every numeric column
- **Session detail** — fixed-height scrollable table
- **Settings** (gear icon, collapsed by default) — price table, display rates, model alias map, data notes
- Numbers use compact formatting (`1.4M`/`1.4亿` depending on locale in Chinese build; `hover` shows exact count); cost respects the selected display currency.

## Time Window & Cost Semantics

- Default **last 3 days** `Asia/Shanghai`; switchable to 7/30/90/custom. The window strictly applies to every aggregation.
- Price stored in **¥ per million tokens**; the header currency selector only affects display (converted via `Settings → Rates`).
- `actual` — real cost from `usage.cost.total` recorded by the provider.
- `estimated` — price-derived fallback when no real cost exists (always pay-as-you-go semantics).
- Need a single day's spend? Set the range to that day (the per-day dimension is folded into the time-window filter).
- Cost is evaluated at **model×day** granularity: if that cell has real cost, use it; otherwise estimate. This keeps the three views numerically identical.

## Usage Aggregation (pi)

A single event can carry usage in multiple places — all are counted for the session it belongs to:

| Location | Scenario | Model attribution |
|---|---|---|
| `message.usage` + `role=assistant` | Main conversation | `message.model` |
| `message.details.results[].usage` | **subagent** — one entry per child agent | that result's `model` |
| `message.usage` + `role=toolResult` | In-tool LLM calls (e.g. `formal_review`) | `details.model` fallback `message.model` |
| Top-level `usage` (`compaction` etc.) | Context compaction | No model on the event → attributed to the session's most recent assistant model |

- All-zero placeholder usages (failed subagent stub) are skipped — they don't pollute the model dimension.
- Subagent `cost` is a bare number, assistant `cost` is `{ total }` — both are collected.
- Empty `totalTokens` falls back to `input+output+cacheRead+cacheWrite`.
- Bump `PARSER_VERSION` in `src/scan.ts:36` when changing parsing semantics, otherwise the disk cache won't invalidate.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/data` | Scan result + price config (duplicate requests coalesced within 2 s) |
| `GET`/`POST` | `/api/prices` | Read / save price config (atomic `tmp+rename`, POST limited to local `Origin`/`Host`) |
| `GET` | `/health` | Health check (`{ ok, uptime }`) |

## Configuration

All in `prices.json` (via `GET/POST /api/prices` or the Settings panel):

- **`prices`** — `model → { input, output, cacheRead, cacheWrite }` in ¥/M tokens. Fill official defaults with one click in the UI (`public/js/defaults.js:5`).
- **`rates`** — `currency → rate` where `rate = 1 unit of that currency = N ¥` (e.g. `$: 7.2`). Used only for display conversion.
- **`modelAliases`** — `rawName → normalizedName`, one per line as `raw = normalized` in the textarea. Built-in: strips org prefix unless the tail is generic (`free`/`latest`/…), lowercases, `:`→`-`; aliases take precedence and keep `-free` etc. distinct for pricing.
- **`currency`** — price-currency symbol (always `¥`).

## Project Structure

```
src/
  scan.ts      # pi jsonl parsing (prefilter / concurrency / disk cache) + alias + multi-source merge
  opencode.ts  # opencode SQLite (node:sqlite read-only) → same SessionAgg shape
  util.ts      # shared pure helpers (addUsage, shanghaiDate, normalizeModelName, aliasHash)
  server.ts    # HTTP server + static hosting + hardened /api/* handlers
  types.ts     # data model (Usage / SessionAgg / PriceConfig / ScanResult)
public/
  index.html   # single-page shell (pi / opencode tabs)
  style.css
  js/          # app / state / api / aggregate / render / calendar / format / defaults
test/          # node:test suites + fixtures
prices.json    # runtime config (gitignored)
.cache/        # scan disk cache (auto-generated, gitignored; override via PI_SCAN_CACHE)
manager.sh (+ manager.command symlink) / start.command / stop.command
```

## Performance

- **Cold scan** — line prefilter avoids `JSON.parse` on text-only rows (user messages dominate) + 8 concurrent workers overlapping I/O and parsing.
- **Warm restart** — disk cache reuses aggregated results keyed by `mtime:size + alias hash`; e.g. 532 sessions: ~5.4 s → ~0.2 s.
- **Hot** — in-memory incremental refresh; `/api/data` coalesces concurrent scans within a 2 s window.

## Development

```bash
npm run typecheck && npm test
./manager.sh restart
```

- After changing scanning/aggregation logic, verify `Σ(model) == total` with real data — gap must be `0` (see `AGENTS.md`).
- Service management: always use `./manager.sh <start|stop|restart|status>` (`manager.command` is a compat symlink) in scripts; `start.command` pops a browser.

## License

No license file yet — all rights reserved by default. Add a `LICENSE` if you intend to open-source under MIT/Apache-2.0/etc.
