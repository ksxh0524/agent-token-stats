# agent-token-stats

> Local dashboard for coding-agent token usage — supports **pi** ([badlogic/pi-mono](https://github.com/badlogic/pi-mono)) and **opencode** as data sources, with breakdowns by **source / workspace / session / day / model / provider**.

[中文](./README.zh-CN.md) | **English**

[![Node >=22.6](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![No build – ES modules](https://img.shields.io/badge/frontend-zero--build-orange)](#project-structure)

Zero runtime dependencies (only devDependencies: `typescript` / `prettier`; SQLite via the built-in `node:sqlite`). Frontend is zero-build native ES modules. Aggregates persist in a local SQLite store; day-to-day scans are incremental and finish in seconds.

---

## Features

- **Multi-source, strictly isolated** — ships with `pi` (`~/.pi/agent/sessions/*.jsonl`) and `opencode` (`~/.local/share/opencode/opencode.db`). UI tabs are generated from the `/api/data` sources keys — adding a new source (codex / claude code / …) means one backend adapter, zero frontend changes.
- **SQLite persistence + archive promise** — aggregates live in `.cache/store.db` (override with `PI_SCAN_DB`): sessions deleted at the source keep their stats and get an archive badge; pi resume/branch files sharing one session id are merged, never double-counted.
- **Incremental scanning** — pi parses only appended bytes via byte offsets (a one-line append to a 65MB session reads ~30 bytes), opencode rebuilds keyed on the db signature; parser context (model attribution / session name) persists alongside the cursor.
- **Rich dimensions** — workspace total, per-model, model detail (with bar chart + sortable table), per-provider, session detail.
- **Time window** — default **last 3 days** in `Asia/Shanghai` timezone; switch 7/30/90 days or pick a custom range. The window filters every dimension.
- **Cost model** — per-million-token price stored in **¥**; display currency is converted via configurable rates. `actual` = provider-recorded `usage.cost.total`, `estimated` = price×tokens fallback. Cost is resolved at **model × day** granularity so all views stay consistent.
- **Model normalization** — strips org prefix (`deepseek-ai/`, `nvidia/`), lowercases, colon→hyphen, with an editable alias map.
- **Incremental polling** — the dashboard polls every 30s with a data revision; when nothing changed the server replies with ~100 bytes (measured: 1.1MB full payload → 98 bytes) and the frontend skips re-rendering entirely. The session table renders in batches (first 150 rows, auto-append on scroll).

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
| `PI_SCAN_DB` | `./.cache/store.db` | own aggregate store (SQLite, holds archives and scan cursors) |

> `prices.json` and `.cache/` are gitignored. Bump `PARSER_VERSION` in `src/sources/pi.ts` (or `OPENCODE_PARSER_VERSION` in `src/sources/opencode.ts`) when changing parsing semantics — stale-semantics aggregates get invalidated and re-scanned (see `AGENTS.md`).

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
- Bump `PARSER_VERSION` in `src/sources/pi.ts` when changing parsing semantics — stored aggregates with the old semantics are invalidated and re-scanned.

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
  scan.ts          # scan coordinator: adapter registry (ADAPTERS) + multi-source merge
  store.ts         # own SQLite store: units (cursor + aggregate + archive) + meta (revision); upsert-only, never deletes
  sources/
    pi.ts          # pi jsonl adapter: byte-offset incremental + persisted parser context
    opencode.ts    # opencode SQLite adapter: db-signature incremental
  server.ts        # HTTP server + static hosting + hardened /api/* + rev short-circuit
  types.ts         # data model (SourceAdapter / SessionAgg / ScanResult)
public/
  index.html       # single-page shell (source tabs generated dynamically)
  style.css
  js/              # app / state / api / aggregate / render / calendar / format / defaults
test/              # node:test suites + fixtures (incl. archive & polling cases)
prices.json        # runtime config (gitignored)
.cache/store.db    # own aggregate store (auto-generated, gitignored; override via PI_SCAN_DB)
manager.sh (+ manager.command symlink) / start.command / stop.command
```

## Performance

- **First build** — line prefilter avoids `JSON.parse` on text-only rows + 8 concurrent workers; ~870 session files ingest in ~2 minutes (happens once).
- **Restarts / polling** — cursors (byte offsets + parser context) survive restarts; incremental scan ≈ 0.6s. With no changes `/api/data` replies ~100 bytes and the frontend skips re-rendering.
- **Parser changes** — bumping `PARSER_VERSION`/`OPENCODE_PARSER_VERSION` triggers one full re-ingest, then back to incremental.

## Development

```bash
npm run typecheck && npm test
./manager.sh restart
```

- After changing scanning/aggregation logic, verify `Σ(model) == total` with real data — gap must be `0` (see `AGENTS.md`).
- Service management: always use `./manager.sh <start|stop|restart|status>` (`manager.command` is a compat symlink) in scripts; `start.command` pops a browser.

## License

No license file yet — all rights reserved by default. Add a `LICENSE` if you intend to open-source under MIT/Apache-2.0/etc.
