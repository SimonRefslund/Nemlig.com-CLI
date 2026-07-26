# nemlig CLI

An unofficial command-line client for [nemlig.com](https://www.nemlig.com/).
It supports public catalog search plus signed-in account, basket, order history,
delivery-slot, and checkout-preparation flows, and cross-chain price comparison
via [goma.gg](https://goma.gg/).

> Dansk læs-mig: [README.md](README.md)

## Let an AI agent do the shopping

Every command speaks `--json`, everything that mutates requires `--yes`, and
**no command can complete a purchase**. That combination makes this safe to
hand to an agent — Claude Code, a cron agent, whatever you run — without giving
it the ability to spend your money.

Give it a task like *"see what we bought last time, refill the basket, tell me
what's cheaper at the other chains, and reserve a free delivery slot this
weekend"*, and it can do the whole thing:

```sh
nemlig orders --limit 1 --json              # what was ordered last time?
nemlig orders show <order-number> --json    # the individual lines
nemlig basket add <product-id> <qty> --yes  # refill the basket
nemlig compare --json                       # where is it cheaper?
nemlig delivery slots --days 7 --json       # find a 0 kr. slot
nemlig delivery select <timeslot-id> --yes
nemlig checkout status                      # anything missing?
```

The last step is the one it cannot take. `checkout open` hands the basket to
your browser, and payment, terms, and MobilePay stay with you — after you have
seen the total. The worst an agent can do is fill your basket.

The API calls were mapped from Firefox's Network Monitor. Cookies, bearer
tokens, anti-forgery values, personal details, and basket contents were excluded
from the saved capture.

## Requirements

- Node.js 20 or newer
- Firefox for the final checkout/payment flow

## Install

```sh
npm link
nemlig --help
```

You can also run it without linking:

```sh
node src/cli.js search "økologisk mælk" --limit 5
```

## Public catalog

```sh
nemlig search kaffe
nemlig search kaffe --limit 5 --offset 20
nemlig suggest kaff
nemlig product 5035178
nemlig product kaffe-oeko-5035178
nemlig product https://www.nemlig.com/kaffe-oeko-5035178
nemlig search kaffe --json | jq '.products[] | {Id, Name, Price}'
```

Product IDs used by basket commands are shown by `search` and `product`.
Only the full slug is addressable on nemlig.com, so `product <id>` resolves the
slug through search first — one extra request.

Options accept `--limit 5` and `--limit=5`. Use `--` to end option parsing when
a search term starts with a dash.

## Account

```sh
nemlig account login you@example.com
nemlig account status
nemlig account logout
```

Login prompts for the password without echo. The password is sent only to
`https://www.nemlig.com/webapi/login` and is never written to disk. Session
cookies are saved to:

| Platform | Location |
| --- | --- |
| macOS/Linux | `~/.config/nemlig-cli/session.json` (or `$XDG_CONFIG_HOME`) |
| Windows | `%APPDATA%\nemlig-cli\session.json` |

The directory is private and the session file is forced to mode `0600` on Unix.
Writes go through a temporary file and a rename, so an interrupted run cannot
leave a half-written session. Set `NEMLIG_CONFIG_DIR` to choose another
directory.

| Variable | Effect |
| --- | --- |
| `NEMLIG_CONFIG_DIR` | Directory holding `session.json` |
| `NEMLIG_TIMEOUT_MS` | Per-request timeout, default `20000` |
| `NEMLIG_RETRIES` | Retries on 429/5xx for reads, default `2` |
| `NEMLIG_DEBUG` | Print stack traces on failure |
| `GOMA_API_KEY` | Override the public goma.gg key if it rotates |
| `GOMA_API_ORIGIN` | Override the goma.gg API origin |

Basket writes are never retried, so a retry cannot double a line.

The CLI cannot import the already-open Firefox session. Browser-cookie export is
intentionally avoided; `checkout open` reuses Firefox's own signed-in session.

## Basket

Basket writes require `--yes` so scripts do not mutate it accidentally.
Quantities are absolute for `set` and incremental for `add`.

```sh
nemlig basket
nemlig basket add 5035178 2 --yes
nemlig basket set 5035178 3 --yes
nemlig basket remove 5035178 --yes
nemlig basket clear --yes
```

Basket commands also accept the slug form (`kaffe-oeko-5035178`), so output
from `search` can be piped straight back in.

`basket` shows the product count, per-line discounts, the bag/deposit/delivery
breakdown, and the reserved delivery time. nemlig.com applies its minimum-order
rule to the products subtotal rather than the grand total, so the warning is
computed against `TotalProductsPrice`.

Every command also accepts `--json` where it is useful.

## Orders and delivery

```sh
nemlig orders
nemlig orders --limit 20
nemlig orders show <order-number>

nemlig delivery slots --days 7
nemlig delivery slots --all
nemlig delivery slots --start 2026-07-27 --json
nemlig delivery select <timeslot-id> --yes
```

`delivery slots` lists bookable slots grouped by day and hides sold-out ones;
`--all` includes them. A slot the account has already reserved is always shown
and marked `reserved`, even though nemlig.com reports it as unbookable. Slots
marked `unattended` are the longer no-recipient-needed windows (`Type: 1` in the
response) — that mapping is inferred from the capture, not documented.

Selecting a slot reserves it through the site's
`TryUpdateDeliveryTime` flow. Availability can change between listing and
selection.

## Checkout

```sh
nemlig checkout status
nemlig checkout status --json
nemlig checkout open
```

`checkout status` checks basket totals, address, timeslot, validation failures,
current terms, and age restrictions, and explains each failed check. `checkout
open` launches the site's basket page in Firefox, falling back to the default
browser if Firefox is not installed.

The CLI deliberately does **not** expose `PlaceOrderLoggedIn`. Payment,
acceptance of the current terms, 3-D Secure/MobilePay, and the final order
confirmation remain in Firefox where the total and delivery details are visible.

## Price comparison (goma.gg)

goma.gg tracks grocery offers across 16 Danish chains, nemlig.com included.

```sh
nemlig goma stores
nemlig goma search kaffe --sale --sort discount
nemlig goma search "hakkede tomater" --store Netto --store Lidl
nemlig compare
nemlig compare --store "REMA 1000" --json
```

`compare` looks up every basket line and reports the cheapest comparable
alternative outside nemlig.com. Because the two catalogues share no product
IDs, lines are matched on name similarity and pack size:

- Prices are normalised to a base unit (g, ml, or piece), so a 375 g jar can be
  compared against a 800 g one.
- Matches are rated `high`, `medium`, or `low`; only `high` and `medium` count
  toward the savings estimate, and `medium` rows are printed with a `?`.
- Savings scale to the quantity actually in your basket.
- A line whose pack size cannot be parsed is reported as unmatched rather than
  silently skipped.

Treat the total as a guide, not a quote. `--sort` accepts `relevance`,
`price-asc`, `price-desc`, `discount`, `name-asc`, and `name-desc`.

The client uses the publishable, RLS-protected key that goma.gg's own web app
ships with, and opts out of their search analytics. goma.gg also offers a
sanctioned partner Data API (goma@goma.gg) if you need a contractual footing.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Not signed in, or the session expired |
| `3` | nemlig.com or goma.gg failed, timed out, or was unreachable |
| `64` | Bad usage: unknown command, option, or argument |

## Verify

```sh
npm test
npm run check
```

The suite is hermetic — every network call is stubbed, so tests never reach
nemlig.com or goma.gg. CI runs them on Node 20, 22, and 24 across Linux, macOS,
and Windows.

The sanitized request inventory is in
[`docs/network-capture.json`](docs/network-capture.json), and the goma.gg one in
[`docs/goma-api.json`](docs/goma-api.json). Neither site publishes these web-app
endpoints as a stable public API, so they can change without notice. This
project is not affiliated with nemlig.com or goma.gg.
