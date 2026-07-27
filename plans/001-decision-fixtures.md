# Plan 001: Establish grocery-decision fixtures

> **Executor instructions**: Follow this plan step by step. Run every
> verification command. Stop on a STOP condition; do not improvise. The
> reviewer maintains `plans/README.md`.
>
> **Drift check**: `git diff --stat 426c7bb..HEAD -- test/compare.test.js test/fixtures/compare-cases.json`
> At initial execution this must be empty.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `426c7bb`, 2026-07-27

## Why this matters

The fuzzy join is the core product, but its tests are synthetic and do not
cover organic fidelity, drained weight, whole-pack purchasing, promotions, or
competing confidence tiers. A sanitized fixture vocabulary makes later changes
deliberate and reviewable instead of tuning heuristics by intuition.

## Current state

- `test/compare.test.js:14` tests simple pack strings only.
- `test/compare.test.js:38` intentionally treats an organic and conventional
  name as nearly identical.
- `test/compare.test.js:61` covers exact, different-size, unrelated, and
  incompatible-unit candidates.
- `test/compare.test.js:124` is the only end-to-end savings test and uses
  same-size pasta.
- Tests use `node:test` and `node:assert/strict`; follow that style.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node --test test/compare.test.js` | exit 0 |
| Full tests | `npm test` | 107 existing tests plus new tests pass |
| Syntax | `npm run check` | exit 0 |

## Scope

**In scope**:

- `test/fixtures/compare-cases.json` (new)
- `test/compare.test.js`

**Out of scope**:

- All `src/` files
- Live network calls or captured personal basket data

## Git workflow

- Branch: `codex/price-selection-v2`
- Commit message: imperative style, e.g. `Add grocery matching decision fixtures`
- Do not push or open a PR.

## Steps

1. Add a sanitized JSON fixture corpus containing:
   - exact same-product/same-pack pair;
   - unrelated products;
   - organic source versus organic candidate;
   - organic source versus conventional candidate;
   - `400 g / 240 g` canned product;
   - `950 g` demand versus `700 g` rival pack;
   - same name in two pack sizes;
   - high-confidence and cheaper medium-confidence candidates.
   Each case must include stable IDs, names, brands, descriptions, prices,
   quantities, and expected current classification. Do not include account data.

2. Load fixtures in `test/compare.test.js` using Node's standard library only.
   Add table-driven characterization tests for parsing, similarity,
   `scoreCandidate`, and `compareBasket`. Current-behavior assertions that later
   plans intentionally change must be named `current behavior:` so reviewers
   can distinguish them from desired invariants.

3. Preserve every existing assertion and keep all tests hermetic.

## Test plan

- Assert that every fixture has a unique case ID.
- Assert that fixture inputs produce finite prices and explicit confidence.
- Assert the current fractional-pack and organic-stop-word behavior as named
  characterization tests; later plans must update those exact expectations.

## Done criteria

- [ ] Fixture file exists and contains all eight case families.
- [ ] `node --test test/compare.test.js` passes.
- [ ] `npm test` and `npm run check` pass.
- [ ] Only the two in-scope files changed.

## STOP conditions

- Stop if a fixture requires real user/account/basket data.
- Stop if a test needs network access or a new dependency.
- Stop if current production behavior differs from the cited code at `426c7bb`.

## Maintenance notes

Future matcher changes must update the fixture expectation and explain why.
Do not optimize for fixture pass-rate by weakening hard substitution rules.
