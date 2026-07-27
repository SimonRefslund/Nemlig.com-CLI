# nemlig CLI

An unofficial command-line client for [nemlig.com](https://www.nemlig.com/)
with price comparison through [goma.gg](https://goma.gg/).

Use it to:

- search the nemlig.com catalogue;
- manage a signed-in basket;
- learn from previous orders and refill regular purchases;
- find and reserve delivery slots;
- compare basket prices across Danish grocery chains.

The CLI can prepare a basket, but it cannot place an order. Checkout and
payment always happen in your browser.

## Requirements

- Node.js 20 or newer
- A browser for checkout

## Install

```sh
git clone https://github.com/tobiasdosdal/Nemlig.com-CLI.git
cd Nemlig.com-CLI
npm link
nemlig --help
```

There are no runtime dependencies. You can also run the CLI without linking
it:

```sh
node src/cli.js search "økologisk mælk" --limit 5
```

## Quick start

Sign in:

```sh
nemlig account login you@example.com
nemlig account status
```

Search and build a basket:

```sh
nemlig search kaffe --limit 5
nemlig product 5035178
nemlig basket add 5035178 2 --yes
nemlig basket
```

Compare the basket and check whether rival prices are historically good:

```sh
nemlig compare
nemlig compare --history
nemlig compare --store Netto --store Lidl --json
```

Reserve a delivery slot and hand off to the browser:

```sh
nemlig delivery slots --days 7
nemlig delivery select <timeslot-id> --yes
nemlig checkout status
nemlig checkout open
```

`checkout open` is the final CLI step. It does not confirm or pay for the
order.

## Basket commands

Basket changes require `--yes`. `add` is incremental, while `set` replaces the
quantity with an absolute value.

```sh
nemlig basket
nemlig basket add 5035178 2 --yes
nemlig basket set 5035178 3 --yes
nemlig basket remove 5035178 --yes
nemlig basket clear --yes
```

Product IDs and slugs from `search` are both accepted. `basket clear` also
removes any reserved delivery slot and cannot be undone.

## Repeat regular purchases

`habits` estimates purchase cadence from previous orders. `reorder` shows a
proposal unless `--yes` is supplied.

```sh
nemlig habits --orders 20 --min-orders 3
nemlig reorder
nemlig reorder --yes
nemlig orders --limit 5
nemlig reorder --from <order-number> --yes
```

Cadence is based on the median number of days between purchases. Products that
appear to have been dropped are marked as lapsed and excluded from `reorder`.
Items already in the basket are not added again.

## Price comparison

`compare` searches goma.gg for alternatives to every basket line. The two
catalogues do not share product IDs, so results are estimates based on product
names, variants, and pack sizes.

The important rules are:

- Explicitly organic basket items only match explicitly organic alternatives.
- High-confidence matches are preferred over medium-confidence matches.
- A `?` marks a medium-confidence result.
- Savings use the cost of the whole rival packs you would need to buy.
- Campaign prices are used when their quantity requirements are met.
- `BEST FOUND` means the bounded search did not inspect every possible result.

Different pack sizes can still be compared per kilogram, litre, or piece, but
surplus product is not counted as a saving. Treat the total as a guide, not a
quote, and check the matched product name before acting on it.

Use `--history` to judge each cheaper winner against its recent price history:

```sh
nemlig goma history kaffe --store Netto
nemlig goma history "hakkede tomater" --store Netto --days 180 --json
nemlig compare --history
```

Being cheaper than nemlig.com and being a good price are separate claims. A
history verdict needs at least 30 dated observations spanning at least 30
days; thinner histories are reported without a verdict.

For exact JSON fields, confidence diagnostics, and matching rules, see
[AGENTS.md](AGENTS.md).

## Automation and agents

Useful commands support `--json`, and every mutation requires `--yes`. The CLI
also uses stable exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Not signed in or session expired |
| `3` | nemlig.com or goma.gg failed |
| `64` | Invalid command or option |

[AGENTS.md](AGENTS.md) contains the complete machine-facing reference,
including JSON shapes, retry rules, mutation safety, and agent workflows.

No command exposes nemlig.com's final order endpoint. An automated process can
fill a basket and reserve a slot, but it cannot spend money.

## Account data

The password is sent only to nemlig.com's login endpoint and is never saved.
Session cookies are stored locally:

| Platform | Location |
| --- | --- |
| macOS/Linux | `~/.config/nemlig-cli/session.json` |
| Windows | `%APPDATA%\nemlig-cli\session.json` |

Set `NEMLIG_CONFIG_DIR` to choose another directory. On Unix, the session file
uses mode `0600` and is written atomically.

## Environment

| Variable | Effect |
| --- | --- |
| `NEMLIG_CONFIG_DIR` | Session directory |
| `NEMLIG_TIMEOUT_MS` | Request timeout; default `20000` |
| `NEMLIG_RETRIES` | Read retries for 429/5xx; default `2` |
| `NEMLIG_DEBUG` | Print stack traces |
| `GOMA_API_KEY` | Override the goma.gg API key |
| `GOMA_API_ORIGIN` | Override the goma.gg API origin |

Basket writes are never retried.

## Development

```sh
npm test
npm run check
```

Tests are hermetic and do not contact nemlig.com or goma.gg. CI runs on Node
20, 22, and 24 across Linux, macOS, and Windows.

The sanitized request inventories are in
[`docs/network-capture.json`](docs/network-capture.json) and
[`docs/goma-api.json`](docs/goma-api.json). These web-app endpoints are not
published as stable APIs and can change without notice.

This project is not affiliated with nemlig.com or goma.gg.
