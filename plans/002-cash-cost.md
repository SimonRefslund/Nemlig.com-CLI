# Plan 002: Calculate effective prices and whole-pack cash cost

> **Executor instructions**: Follow each step and verification. Stop on a STOP
> condition. The reviewer maintains the plan index.
>
> **Drift check**: `git diff --stat 426c7bb..HEAD -- src/compare.js src/format.js test/compare.test.js test/format.test.js test/fixtures/compare-cases.json README.md AGENTS.md`
> Changes from completed Plan 001 are expected only in the listed test files;
> reconcile its fixture names before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: bug
- **Planned at**: commit `426c7bb`, 2026-07-27

## Why this matters

Current savings assume rival packs are divisible. For a 950 g need and a 700 g
pack, the CLI prices 1.36 packs instead of the two packs charged at checkout.
Nemlig search output also renders base `Price`/`UnitPriceCalc` even when
`Campaign.CampaignPrice` and `Campaign.CampaignUnitPrice` are the effective
prices.

## Current state

- `src/compare.js:131` picks the first non-piece amount from free text.
- `src/compare.js:152` lets that parsed amount override the amount implied by
  Nemlig's unit-price fields.
- `src/compare.js:269` calculates saving from exact consumed volume.
- `src/format.js:91` renders `product.Price`; `src/format.js:134` does the same
  in product detail.
- `src/format.js:151` reports campaign type but omits percentage-campaign price.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `node --test test/compare.test.js test/format.test.js` | exit 0 |
| Full tests | `npm test` | all pass |
| Syntax | `npm run check` | exit 0 |

## Scope

**In scope**:

- `src/compare.js`
- `src/format.js`
- `test/compare.test.js`
- `test/format.test.js`
- `test/fixtures/compare-cases.json`
- `README.md`
- `AGENTS.md`

**Out of scope**:

- New CLI commands
- Goma request strategy
- Basket mutation
- Valuing surplus as future savings

## Git workflow

- Branch: `codex/price-selection-v2`
- Commit: `Calculate savings from whole-pack cash cost`
- Do not push or open a PR.

## Steps

1. Refactor pack parsing so all plausible measurements are retained internally.
   When `UnitPriceCalc` and `UnitPriceLabel` imply a pack amount, select the
   parsed measurement closest to that amount. This must choose 240 g for a
   `400 g / 240 g` product when the official unit price implies 240 g, while
   preserving `12 x 400 g` as 4,800 g when unit-price data agrees. If sources
   remain materially inconsistent, expose ambiguity instead of silently
   selecting an arbitrary first value.

2. Add purchase economics to each rated candidate:
   `requiredAmount`, `packsNeeded`, `purchaseAmount`, `surplusAmount`,
   `purchaseCost`, and `normalizedCostForRequiredAmount`.
   `packsNeeded = ceil(requiredAmount / candidate.pack.amount)`.
   Make `saving` and `cheaper` reflect `line.perItem * line.quantity -
   purchaseCost`. Preserve normalized unit price and expose normalized saving
   under a new, clearly named field for analysis.

3. Add a pure effective-Nemlig-price helper used by search and product
   rendering. Prefer finite positive `Campaign.CampaignPrice` and
   `Campaign.CampaignUnitPrice`. For quantity offers, show the threshold and
   total price without pretending the offer applies to a single unit.
   Display base price alongside the campaign price when they differ.

4. Update README and AGENTS JSON/output semantics. State that cash saving uses
   whole packs and surplus receives zero value.

## Test plan

- 950 g need versus 700 g at 25.50 kr: two packs, 1,400 g purchased, 450 g
  surplus, 51 kr cash outlay, and no false saving against 37.76 kr.
- 500 g peas versus 400 g pack: two rival packs.
- 200 g need versus 500 g mozzarella: one rival pack, no fractional purchase.
- `400 g / 240 g` selects the measurement consistent with official unit price.
- 12 × 400 g retains 4,800 g.
- Percentage campaign renders 37.76 kr instead of base 41.95 kr.
- Quantity campaign is not applied below its minimum quantity.

## Done criteria

- [ ] No fractional rival pack contributes to `saving`.
- [ ] New purchase-economics fields are finite for comparable candidates.
- [ ] Campaign prices are visible in human product/search output.
- [ ] Focused tests, `npm test`, and `npm run check` pass.
- [ ] Only in-scope files changed.

## STOP conditions

- Stop if live field semantics contradict the captured names; report the exact
  field names, not any user data.
- Stop if fixing pack semantics requires category-specific assumptions without
  a deterministic fallback.
- Stop if compatibility requires silently retaining the false cash-saving
  meaning; propose a versioned field instead.

## Maintenance notes

Reviewers should scrutinize multipacks, discounts, and floating-point rounding.
Future stock-up features may value surplus, but the default recommendation must
optimize today's checkout payment.
