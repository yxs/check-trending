# Dashboard: multi-year trend window + adaptive chart

**Date:** 2026-06-28
**Status:** approved (brainstorm)

## Goal

The main page is a statistical-trend dashboard. Expand its data window from the
arbitrary `2023-01-01` to a principled post-COVID window, and rework the trend
chart so a multi-year span stays readable instead of a 2,000-bar horizontal
scroll. Notes search (`/notes`) already covers all cases and is out of scope.

## Decisions (data-backed)

### 1. Data window → `2021-01-01`
Post-COVID is a single comparable regime; 2020 is a COVID anomaly (435 cases,
10% >180d) and 2017–19 is a non-comparable "fast era" that triples payload.
2021+ captures the full recovery → normalize → 2025-slowdown arc.

- ~13,286 cases, ~8,600 with-note.
- Payload: 6.14MB raw / **1.23MB gzip** (lighter than the notes page's 1.74MB,
  already shipped). Loaded once, cached.

### 2. Stale-Pending threshold → `730` days (2 years)
A non-terminal case older than the cutoff is presumed resolved-offline and
excluded from the Pending-backlog counts and the median/P90 wait stats.

`365` (the current value) was set from the real Clear-completion distribution,
but that distribution is right-censored — genuine multi-year administrative-
processing cases are still Pending, so they never enter the Clear sample. Field
knowledge (community of genuine ~1-year waiters) confirms 365 is too low.

Two censoring-independent signals converge on **2 years**:
- In 20,743 real Clears (2017+), only 8 ever cleared after >2y, 1 after >2.2y,
  **0 after >2.5y** — past 2y the genuine clear rate is ~0.04%.
- The Pending age histogram is a smooth trickle 1–3y then a wall at 5y+ (4,023
  dead 2017–19 cases).

730d keeps the entire 1–2y genuine cohort (active Pending 958→1,656, backlog
≥270 153→851, P90 wait 106d→208d) while excluding the dead wall.

### 3. Trend chart → adaptive granularity (single chart)
The time-range selector doubles as a granularity switch, derived from the
visible span:

| Range | Span | Granularity |
|---|---|---|
| 最近 90 / 180 天 | ≤180d | day (current detail) |
| 最近 12 / 24 个月 | ≤730d | week |
| 全部(2021 至今) | >730d | month |

- **Default = 全部 / month** — the whole arc on one screen, no scroll, mobile-
  friendly; the 2025 slowdown shows as a rising trailing average.
- Trailing average adapts to bucket count (day→7, week→4, month→3).
- Drill-down: click a month/week bar → range narrows to that period (granularity
  steps down); click a day bar → existing "selected-date Clear detail" table.

### 4. Remove the "近期节奏与低速区间" panel
Low value in practice. Delete the panel, the low-tide threshold control, and its
supporting code: `buildCurrentStatus`, `findLowTideRuns`, the `LowTideRun` /
`CurrentStatus` / `LowTideThreshold` types, related tests, and the `lt` URL
param in viewState. The "selected-date Clear detail" table (previously paired
beside it) becomes full-width.

### 5. Out of scope (future lever)
Payload slimming — moving Note text out of `app-data.json` and lazy-loading it —
would cut the main payload to ~401KB gzip. Not needed at 1.23MB; revisit only if
the window ever extends back toward 2017.

## Components touched

- `scripts/sync_dashboard_from_harvest.py` — `START='2021-01-01'`, docstring.
- `src/analytics.ts` — `STALE_PENDING_DAYS=730`; add `bucketClearSeries(series,
  granularity)` + trailing-average-by-bucket; remove `buildCurrentStatus`,
  `findLowTideRuns`.
- `src/App.tsx` — range→granularity selection; chart consumes bucketed series;
  bar-click drill-down; remove the low-tide section + threshold state; backlog
  caption "满 2 年"; selected-date detail full-width.
- `src/viewState.ts` — drop `lt`; range options updated (90/180 天, 12/24 个月,
  全部).
- `src/types.ts` — drop low-tide types; add `Granularity`.
- `src/styles.css` — remove low-tide styles; detail panel full-width.
- Tests — `analytics.test.ts`: bucketing (day/week/month) + stale=730; remove
  low-tide tests; `viewState.test.ts`: drop `lt`.
- Regenerate `data/checkee/*` + `public/data/app-data.json`.

## Testing

- `bucketClearSeries`: day = identity; week sums into 7-day bins with correct
  start labels; month sums into YYYY-MM; noteCount aggregates alongside count.
- Trailing average over N buckets at each granularity.
- Stale=730 backlog exclusion (extend existing stale test).
- Range→granularity mapping (≤180 day, ≤730 week, else month).
- Regression: existing daily series / metrics / backlog tests still pass.
- Manual browser verify: monthly default renders the full arc; drill-down month→
  day works; numbers match the analysis (backlog ≥270 = 851, P90 = 208).
