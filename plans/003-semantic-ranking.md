# Plan 003: Enforce semantic constraints and rank by confidence

> **Executor instructions**: Follow the plan exactly and stop on a STOP
> condition. The reviewer maintains the index.
>
> **Drift check**: `git diff --stat 426c7bb..HEAD -- src/compare.js src/goma.js test/compare.test.js test/goma.test.js test/fixtures/compare-cases.json README.md AGENTS.md`
> Expected dependency changes from Plans 001–002 must be understood first.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 002
- **Category**: bug
- **Planned at**: commit `426c7bb`, 2026-07-27

## Why this matters

`øko` and `økologisk` are discarded as stop words, so a conventional product
can be recommended for an organic basket line. The winner is then selected by
unit price alone, allowing a weak medium match to displace an exact high match.

## Current state

- `src/compare.js:34` removes organic markers.
- `src/compare.js:53` contains a limited flat variant-marker set.
- `src/compare.js:198` calculates score/confidence.
- `src/compare.js:265` ignores both when sorting by price.
- `src/goma.js:119` always sends `p_labels_filter: null`, though the captured
  API supports labels; exact label vocabulary is not documented.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node --test test/compare.test.js test/goma.test.js` | exit 0 |
| Full tests | `npm test` | all pass |
| Syntax | `npm run check` | exit 0 |

## Scope

**In scope**:

- `src/compare.js`
- `src/goma.js`
- `test/compare.test.js`
- `test/goma.test.js`
- `test/fixtures/compare-cases.json`
- `README.md`
- `AGENTS.md`

**Out of scope**:

- Universal nutrition or quality scoring
- Allergens not present in available basket/Goma fields
- Guessing undocumented goma label values
- Automatic basket replacement

## Git workflow

- Branch: `codex/price-selection-v2`
- Commit: `Preserve organic constraints in price matching`
- Do not push or open a PR.

## Steps

1. Extract semantic attributes separately from lexical tokens. At minimum
   support organic markers (`øko`, `økologisk`, `organic`) and existing
   dietary/processing variant markers. Do not remove semantic information
   before eligibility is determined.

2. If the source line explicitly requires organic and the candidate does not
   explicitly indicate organic, reject it with reason `organic_mismatch`.
   Preserve current behavior for source lines without an organic marker.
   Expose semantic match/mismatch fields in candidate diagnostics.

3. Keep goma label filtering optional in `GomaApi.search`, with a tested
   `labels` option passed to `p_labels_filter`. Do not activate an unknown
   production label by default; document that text-based enforcement remains
   authoritative until label vocabulary is verified.

4. Rank eligible candidates lexicographically:
   cheapest high-confidence candidate first; only use medium when no high
   candidate exists. Use matcher score and cash purchase cost as documented
   tie-breakers. Preserve cheaper medium options as alternatives with explicit
   reasons; do not include them in the default winner when high exists.

5. Split summary counts and savings by confidence tier.

## Test plan

- Organic source + conventional candidate is rejected.
- Organic source + organic candidate remains eligible.
- Conventional source may match a conventional candidate.
- A high-confidence candidate wins over a cheaper medium candidate.
- A medium candidate wins when no high candidate exists.
- Goma search serializes explicit labels and defaults to `null`.

## Done criteria

- [ ] Organic requirements cannot silently downgrade.
- [ ] High-confidence candidates are preferred over medium candidates.
- [ ] JSON exposes confidence-tier totals.
- [ ] Focused tests, `npm test`, and `npm run check` pass.
- [ ] Only in-scope files changed.

## STOP conditions

- Stop rather than guess if reliable organic status cannot be derived from
  either source.
- Stop if stricter matching makes the existing exact organic fixtures
  unmatchable; report the missing field vocabulary.
- Stop if a ranking change cannot be explained deterministically in JSON.

## Maintenance notes

Keep constraints explicit and user-controlled. Do not collapse “organic,”
“premium,” “brand,” and “healthy” into one opaque quality score.
