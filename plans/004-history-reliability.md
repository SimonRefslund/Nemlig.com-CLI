# Plan 004: Make price-history verdicts reliable and efficient

> **Executor instructions**: Follow each step and verification. Stop on a STOP
> condition. The reviewer maintains the index.
>
> **Drift check**: `git diff --stat 426c7bb..HEAD -- src/pricehistory.js src/cli.js test/pricehistory.test.js test/cli.test.js README.md AGENTS.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 001
- **Category**: bug/perf
- **Planned at**: commit `426c7bb`, 2026-07-27

## Why this matters

Any non-empty history currently receives a confident verdict; live results with
five or eleven days have been called “normal.” `compare --history` also fetches
history for every matched winner even though the renderer shows only cheaper
rows.

## Current state

- `src/pricehistory.js:38` marks data insufficient only when empty.
- `src/pricehistory.js:65` assumes incoming point order when finding the last
  cheaper day.
- `src/cli.js:606` selects all rows with `best.productId`.
- `src/format.js:521` renders only cheaper rows.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node --test test/pricehistory.test.js test/cli.test.js` | exit 0 |
| Full tests | `npm test` | all pass |
| Syntax | `npm run check` | exit 0 |

## Scope

**In scope**:

- `src/pricehistory.js`
- `src/cli.js`
- `test/pricehistory.test.js`
- `test/cli.test.js`
- `README.md`
- `AGENTS.md`

**Out of scope**:

- Changing goma's history endpoint
- Forecasting future prices
- Store-trip optimization

## Git workflow

- Branch: `codex/price-selection-v2`
- Commit: `Require sufficient history before price verdicts`
- Do not push or open a PR.

## Steps

1. Sort valid history points by ISO date before deriving lowest date and
   last-cheaper date. Count distinct dates and calculate calendar span.

2. Define and export documented sufficiency constants. Default to at least
   30 distinct dates spanning at least 30 days. When insufficient, return
   `days`, `spanDays`, `insufficientData: true`, and no verdict. Keep raw
   lowest/average fields only if clearly labeled descriptive; do not call the
   price good/normal/bad.

3. In `compare --history`, fetch only rows where `row.cheaper` and
   `row.best.productId` are truthy. Deduplicate product IDs, fetch each once
   with the existing concurrency cap, and attach the result to all applicable
   rows. Preserve per-row error reporting.

4. Document the sufficiency rule.

## Test plan

- Five and 29 distinct dates are insufficient.
- Thirty dates over at least 30 days produce a verdict.
- Thirty duplicate points on one date remain insufficient.
- Descending input still produces the correct last-cheaper date.
- CLI fetches history only for cheaper rows and deduplicates shared IDs.

## Done criteria

- [ ] Thin histories never receive a verdict.
- [ ] History calls are limited to unique cheaper winners.
- [ ] Focused tests, `npm test`, and `npm run check` pass.
- [ ] Only in-scope files changed.

## STOP conditions

- Stop if API dates are not stable ISO calendar dates.
- Stop if existing documented consumers require a verdict for thin histories;
  report the compatibility requirement before changing it.

## Maintenance notes

The threshold is a product policy, not a statistical certainty. Keep it named,
tested, and easy to revise rather than scattering magic numbers.
