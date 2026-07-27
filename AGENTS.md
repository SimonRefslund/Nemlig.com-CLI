# Using this CLI as an agent

`nemlig` is a command-line client for nemlig.com (Danish groceries) with price
comparison across 15 other chains via goma.gg. It is built to be driven by a
program: every useful command takes `--json`, everything that mutates takes
`--yes`, and **no command can place an order**.

You can fill a basket. You cannot spend money. Payment always happens in the
user's browser.

## Before anything else

```sh
nemlig account status        # exit 0 = signed in, exit 2 = not
```

Exit code `2` on any command means the session is missing or expired. Do not
try to log in on the user's behalf without being asked — `account login` needs
an interactive terminal for the password prompt and will fail if you pipe it.

## Exit codes — branch on these, not on stderr text

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Success | Continue |
| `2` | Not signed in / session expired | Ask the user to run `nemlig account login <email>` |
| `3` | nemlig.com or goma.gg failed, timed out, or was unreachable | Retry once, then report. Reads already retry 429/5xx internally |
| `64` | Bad usage: unknown command, option, or argument | Fix your command; do not retry it unchanged |

## Rules

1. **Always pass `--json`.** Human output is aligned columns and will change.
2. **Never retry a failed write.** `basket add/set/remove`, `delivery select`.
   A retried write can double a line. Read the basket back instead.
3. **`add` is incremental, `set` is absolute.** `add 5035178 2` twice leaves
   quantity 4. Use `set` when you know the number you want.
4. **Confirm before destroying.** `basket clear --yes` is irreversible, drops
   any reserved delivery slot with it, and there is no undo. Snapshot with
   `nemlig basket --json` first and ask the user.
5. **Check the order deadline before mutating.** A basket with a reserved slot
   has a cutoff; changing it close to that cutoff risks the real delivery. The
   deadline is in `nemlig delivery slots --json` under the reserved slot.
6. **Treat `compare` savings as an estimate, never a quote.** See below.
7. Progress messages go to stderr, data to stdout. Piping stdout is safe.

## Commands

Catalog commands need no login. Everything else does.

```sh
nemlig search <query> [--limit n] [--offset n] --json
nemlig suggest <query> --json
nemlig product <id|slug|url> --json

nemlig basket --json
nemlig basket add <id> [qty] --yes
nemlig basket set <id> <qty> --yes
nemlig basket remove <id> --yes
nemlig basket clear --yes

nemlig orders [--limit n] --json
nemlig orders show <order-number> --json

nemlig habits [--orders n] [--min-orders n] --json
nemlig reorder [--orders n] [--from <order-number>] [--yes] --json

nemlig delivery slots [--days n] [--start YYYY-MM-DD] [--all] --json
nemlig delivery select <timeslot-id> --yes

nemlig goma search <query> [--store name]... [--sale] [--sort key] --json
nemlig goma stores --json
nemlig goma history <query|goma-product-id> [--store name] [--days n] --json
nemlig compare [--store name]... [--history] --json

nemlig checkout status --json
nemlig checkout open
```

Options accept `--limit 5` and `--limit=5`. `--store` repeats. Use `--` before
a query that starts with a dash.

## Output shapes

`search` — product `Id` is what basket commands take. `Url` is the slug, also
accepted.

```json
{ "query": "kaffe", "total": 234, "offset": 0,
  "products": [ { "Id": "5035178", "Name": "Kaffe øko.", "Brand": "nemlig basic",
                  "Price": 55.75, "UnitPriceCalc": 139.38, "UnitPriceLabel": "kr/kg",
                  "Url": "kaffe-oeko-5035178",
                  "Availability": { "IsDeliveryAvailable": true, "IsAvailableInStock": true } } ] }
```

Human output prefers positive finite `Campaign.CampaignPrice` and
`Campaign.CampaignUnitPrice`, showing the base price alongside a different
campaign price. A quantity campaign is not applied to one item: its
`MinQuantity` and `TotalPrice` are shown separately until the threshold is met.

`basket` — raw nemlig.com response. The fields that matter:

```json
{ "Lines": [ { "Id": "5062235", "Name": "Fusilli", "Quantity": 1,
               "Price": 17.37, "ItemPrice": 17.37, "DiscountSavings": 11.58 } ],
  "NumberOfProducts": 26, "TotalProductsPrice": 604.66, "TotalPrice": 653.46,
  "DeliveryPrice": 20, "TotalProductDiscountPrice": 233.70,
  "IsMinTotalValid": false, "MinimumOrderTotal": 500,
  "FormattedDeliveryTime": "søn. 26/07 kl. 14-18",
  "ValidationFailures": [] }
```

`Price` is the **line** total; `ItemPrice` is per unit. The minimum-order rule
is applied to `TotalProductsPrice`, not `TotalPrice`, so a basket can clear 500
kr overall and still have `IsMinTotalValid: false`.

`habits` — dates are `YYYY-MM-DD`, never epoch.

```json
{ "ordersAnalyzed": 7, "from": "2025-12-10", "to": "2026-07-18",
  "requested": 7, "failed": 0,
  "products": [ { "id": "5062509", "name": "Sødmælk 25% jersey øko.",
                  "orders": 6, "shareOfOrders": 0.857, "typicalQuantity": 3,
                  "averagePrice": 15.49, "firstBought": "2025-12-10",
                  "lastBought": "2026-06-20", "daysSince": 36,
                  "typicalInterval": 35, "dueInDays": -1,
                  "predictable": true, "lapsed": false } ] }
```

- `typicalInterval` is the **median** days between purchases. `null` when the
  product was bought once (`predictable: false`).
- `dueInDays` negative means overdue.
- `lapsed: true` means bought a few times then dropped — excluded from
  `reorder`. Do not present these as "overdue".
- Two purchases is a guess, not a cadence. Raise `--min-orders` to be strict.

`reorder` — `applied` is `false` unless you passed `--yes`.

```json
{ "applied": false,
  "add": [ { "id": "5062509", "name": "Sødmælk 25% jersey øko.", "quantity": 3,
             "typicalQuantity": 3, "averagePrice": 15.49, "daysSince": 36,
             "dueInDays": -1, "lapsed": false } ],
  "skipped": [ { "id": "5017252", "alreadyInBasket": 5 } ] }
```

`compare` — one row per basket line.

```json
{ "rows": [ { "line": { "id": "5062235", "name": "Fusilli",
                        "quantity": 1, "unitPrice": 0.03474,
                        "pack": { "amount": 500, "base": "g" } },
              "best": { "store": "Lidl", "name": "Combino Fusilli",
                        "unitPrice": 0.0119, "confidence": "high",
                        "semanticEligible": true,
                        "semanticMismatchReasons": [],
                        "requiredAmount": 500, "packsNeeded": 1,
                        "purchaseAmount": 500, "surplusAmount": 0,
                        "purchaseCost": 5.95,
                        "normalizedCostForRequiredAmount": 5.95,
                        "normalizedSaving": 11.42,
                        "onSale": false, "saleValidTo": null },
              "cheaper": true, "saving": 11.42,
              "normalizedSaving": 11.42,
              "selectionReason": "high_confidence_preferred",
              "alternatives": [], "rejected": [], "error": null } ],
  "summary": { "lines": 15, "compared": 13, "cheaperElsewhere": 6,
               "uncomparable": 2, "failed": 0,
               "estimatedSavings": 79.42,
               "confidenceTiers": {
                 "high": { "compared": 10, "cheaperElsewhere": 4,
                           "estimatedSavings": 61.10 },
                 "medium": { "compared": 3, "cheaperElsewhere": 2,
                             "estimatedSavings": 18.32 } },
               "basketTotal": 653.46 } }
```

`unitPrice` is per gram / millilitre / piece — multiply by 1000 for kr/kg or
kr/l. `requiredAmount` is the basket demand in that base unit.
`packsNeeded` is rounded up to a whole rival pack; `purchaseCost` is the cash
outlay for those packs, and `surplusAmount` receives zero value. `saving`
compares that whole-pack outlay with the nemlig.com line total.
`normalizedCostForRequiredAmount` and `normalizedSaving` retain exact-volume
analysis, but must not be presented as checkout cash. `best` is `null` when
nothing comparable was found. `confidenceTiers` splits selected matches and
cash savings into high and medium totals.

`checkout status` — `readiness` is all booleans; check them before telling a
user the order is ready.

```json
{ "checkoutUrl": "https://www.nemlig.com/basket",
  "readiness": { "hasItems": true, "minimumTotalValid": true,
                 "maximumTotalValid": true, "hasDeliveryAddress": true,
                 "hasReservedTimeslot": true, "validationFailures": [] },
  "basket": {}, "terms": {}, "ageRestrictions": {} }
```

`delivery slots` — raw nemlig.com response, nested
`DayRangeHours[].DayHours[]`. Per slot: `Id`, `StartHour`, `EndHour`,
`DeliveryPrice`, `Deadline`, `IsSelected`, and `Availability` (`1` bookable,
`0` not). The slot the account already reserved reports `Availability: 0` with
`IsSelected: true` — that is normal, not an error.

## Judging whether a price is good

`nemlig goma history <query> --json` returns a year of daily prices and, when
the history is sufficient, a verdict. `compare --history` attaches the same
analysis to each cheaper selected winner under `rows[].best.history`. Shared
Goma product IDs are fetched once; matched rows that are not cheaper are not
fetched.

```json
{ "product": { "product_id": "netto-81502000020-EA", "product_name": "Bl. 66 formalet kaffe" },
  "summary": { "productId": "netto-81502000020-EA", "days": 365,
               "spanDays": 364, "price": 66,
               "lowest": 39, "highest": 74.95, "average": 59.19,
               "lowestOn": "2025-11-22", "percentCheaper": 70, "percentile": 70,
               "cheaperDays": 255, "equalDays": 1, "daysOnSale": 118,
               "aboveLowest": 27, "lastCheaper": "2026-07-25", "lastCheaperPrice": 45,
               "verdict": "poor", "verdictLabel": "above its usual price",
               "insufficientData": false },
  "points": [ { "date": "2025-07-14", "price": 65, "normalPrice": 65, "onSale": false } ] }
```

`verdict` is one of `lowest`, `great`, `good`, `normal`, `poor`, `bad`, driven
by `percentile` — the share of days the product cost the same or less, with
ties split. Use `percentile`, not `percentCheaper`, for any judgement: a price
that sits at its yearly high for most of the year has few *strictly* cheaper
days and would otherwise look like a bargain.

Check `insufficientData` before reading any verdict field. A verdict requires
at least 30 distinct ISO calendar dates spanning at least 30 elapsed days.
Insufficient results expose `days`, `spanDays`, and `insufficientData: true`
but no good/normal/bad verdict. **Being cheaper than nemlig.com and being a good
price are different claims** — a rival shop can undercut nemlig.com today
while sitting at its own yearly high. Report both.

## How `compare` matches, and why the total is an estimate

nemlig.com and goma.gg share no product IDs, so lines are matched on name
similarity and pack size, then normalised to a price per gram/ml/piece.

- `confidence: "high"` — names and pack size agree.
- `confidence: "medium"` — comparable per unit, but a different pack size or a
  looser name match. Printed with `?` in human output.
- Low-confidence matches are dropped entirely.
- If a nemlig.com source explicitly contains `øko`, `økologisk`, or `organic`,
  the candidate name or brand must contain an organic marker too. Otherwise it
  is rejected with `rejectionReason: "organic_mismatch"` and retained under
  `rejected` for diagnostics. A conventional source adds no organic constraint.

Only `high` and `medium` count toward `estimatedSavings`. A `medium` row often
means a 375 g jar compared against an 800 g one: the per-kilo maths is right,
but it is a different purchase. Cash savings require enough whole rival packs
to cover the basket amount and assign no value to surplus. **Report the matched
product name, not just the number**, and never tell a user they will save X kr
— tell them what the comparison found.

Ranking is lexicographic and visible in candidate fields: high confidence
before medium, then lower whole-pack `purchaseCost`, higher matcher `score`,
lower normalized `unitPrice`, and finally store and product name. A cheaper
medium candidate remains in `alternatives` but cannot displace a high match.
`selectionReason` reports whether high confidence was preferred or medium was
used as a fallback.

`GomaApi.search` accepts an optional `labels` array and serializes it to
`p_labels_filter`; the default is `null`. The label vocabulary is undocumented,
so do not guess an organic label or enable one by default. Text matching above
is authoritative until a label value is verified.

## Recipes

Refill the basket with what is running out, then check it is orderable:

```sh
nemlig reorder --json                 # inspect first; writes nothing
nemlig reorder --yes --json
nemlig checkout status --json
```

Repeat a previous order exactly:

```sh
nemlig orders --limit 5 --json
nemlig reorder --from <order-number> --yes --json
```

Find what is cheaper elsewhere, worth reporting:

```sh
nemlig compare --json | jq -r '.rows[]
  | select(.cheaper and .best.confidence == "high")
  | "\(.saving|floor) kr  \(.line.name) -> \(.best.store): \(.best.name)"'
```

Book the cheapest bookable slot in the next week:

```sh
nemlig delivery slots --days 7 --json | jq -r '
  [.DayRangeHours[].DayHours[] | select(.Availability == 1)]
  | min_by(.DeliveryPrice) | "\(.Id) \(.DeliveryPrice) kr"'
nemlig delivery select <id> --yes
```

Hand off to the user to pay — this is where you stop:

```sh
nemlig checkout open
```

## What you cannot do

`PlaceOrderLoggedIn` is not exposed and `nemlig checkout place` deliberately
errors. There is no flag, no environment variable, and no code path that
submits an order. If a user asks you to complete the purchase, run
`nemlig checkout open` and tell them to finish in the browser.

## Working on this repo

`npm test` (Node's runner, no network — every call is stubbed) and
`npm run check`. Source is `src/`, one module per concern: `api.js`
(nemlig.com), `goma.js` (goma.gg), `history.js` (order analysis),
`compare.js` (matching), `format.js` (all rendering), `cli.js` (parsing and
dispatch). Renderers must be fed real API field names — several bugs came from
assuming fields that nemlig.com does not return, so check
`docs/network-capture.json` and `docs/goma-api.json` before adding one.
