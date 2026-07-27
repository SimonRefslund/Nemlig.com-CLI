# Plan 005: Broaden candidate retrieval and explain every decision

> **Executor instructions**: Follow the plan step by step and stop on a STOP
> condition. The reviewer maintains the index.
>
> **Drift check**: `git diff --stat 426c7bb..HEAD -- src/compare.js src/goma.js src/format.js test/compare.test.js test/goma.test.js test/format.test.js README.md AGENTS.md`
> Reconcile expected dependency changes from Plans 002–004 first.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 002, 003, 004
- **Category**: correctness/dx
- **Planned at**: commit `426c7bb`, 2026-07-27

## Why this matters

The comparison examines only the first 20 relevance hits, then calls the local
minimum “best.” Rejected candidates disappear, so an agent cannot distinguish
no result from semantic mismatch, bad package data, or low name confidence.

## Current state

- `src/compare.js:219` defaults to 20 candidates.
- `src/compare.js:237` sends no sort/offset and ignores total result count.
- `src/compare.js:228` filters candidates without retaining reason codes.
- `src/compare.js:251` deduplicates fallback results by `store|name` even though
  product ID is available.
- `src/compare.js:286` collapses all no-winner cases into `uncomparable`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node --test test/compare.test.js test/goma.test.js test/format.test.js` | exit 0 |
| Full tests | `npm test` | all pass |
| Syntax | `npm run check` | exit 0 |

## Scope

**In scope**:

- `src/compare.js`
- `src/goma.js`
- `src/format.js`
- `test/compare.test.js`
- `test/goma.test.js`
- `test/format.test.js`
- `README.md`
- `AGENTS.md`

**Out of scope**:

- Unbounded pagination
- A new partner API
- Store travel-cost optimization
- New basket mutation commands

## Git workflow

- Branch: `codex/price-selection-v2`
- Commit: `Explain and broaden Goma candidate selection`
- Do not push or open a PR.

## Steps

1. Introduce a bounded two-pass retrieval strategy:
   - first pass: current relevance search;
   - if `total > fetched`, second pass: `price-asc` with the same bounded limit;
   - brand fallback remains available when no high-confidence candidate exists.
   Cap total search calls per unique query and document the cap.

2. Deduplicate candidates by `productId`, falling back to
   store/name/brand/amount/unit only when ID is absent. Memoize identical
   in-flight query/options combinations within one comparison run.

3. Replace silent filtering with reason codes and aggregated diagnostics:
   `missing_price`, `unknown_pack`, `different_unit`, `low_similarity`,
   `variant_mismatch`, `organic_mismatch`, and `same_store`.
   Per row return retrieval count, eligible count, rejected counts,
   `truncated`, and `winnerReason`. Avoid dumping every rejected product into
   default JSON.

4. Rename human claims so an incomplete candidate set is “best found,” not an
   unqualified global cheapest product. Split high, medium, unmatched, failed,
   and truncated summary counts.

5. Update README and AGENTS output examples and agent guidance.

## Test plan

- A valid cheap product on the price pass can win.
- The second pass is skipped when the first page covers all results.
- Duplicate product IDs collapse; same-name different-size IDs survive.
- Each rejection class increments the correct counter.
- Truncated results are visible in JSON and human output.
- Request count remains within the documented bound.

## Done criteria

- [ ] Retrieval is bounded and reports its coverage.
- [ ] Product-ID deduplication preserves distinct pack variants.
- [ ] Every unmatched row has useful diagnostics.
- [ ] Human output avoids an unqualified “best” claim when truncated.
- [ ] Focused tests, `npm test`, and `npm run check` pass.
- [ ] Only in-scope files changed.

## STOP conditions

- Stop if `price-asc` does not preserve query filtering in the live/stubbed API
  contract.
- Stop if bounded retrieval requires undocumented request fields.
- Stop if diagnostics would expose secrets or user/account data.

## Maintenance notes

The public goma endpoint is undocumented and may change. Keep request count
bounded and diagnostics stable so future API drift is visible rather than
silently degrading recommendations.
