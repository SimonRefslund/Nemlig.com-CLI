# nemlig CLI

Uofficiel kommandolinje-klient til [nemlig.com](https://www.nemlig.com/) med
prissammenligning via [goma.gg](https://goma.gg/).

Søg i varekataloget, styr kurven, se ordrer og leveringstider — og find ud af
hvilke varer i kurven der er billigere i Netto, Lidl, Bilka og 12 andre kæder.

> English reference: [README.en.md](README.en.md)

## Kom i gang

Kræver **Node.js 20 eller nyere**. Virker på macOS, Linux og Windows.

```sh
git clone <repo> nemlig-cli
cd nemlig-cli
npm link          # gør kommandoen "nemlig" tilgængelig
nemlig --help
```

Uden `npm link` kan du køre `node src/cli.js <kommando>` direkte.

## Katalog (kræver ikke login)

```sh
nemlig search kaffe --limit 5
nemlig suggest kaff
nemlig product 5035178
```

## Login

```sh
nemlig account login dig@eksempel.dk
nemlig account status
nemlig account logout
```

Adgangskoden indtastes skjult og gemmes **aldrig**. Kun session-cookies gemmes,
med rettigheder kun for dig:

| Platform | Placering |
| --- | --- |
| macOS/Linux | `~/.config/nemlig-cli/session.json` |
| Windows | `%APPDATA%\nemlig-cli\session.json` |

## Kurv, ordrer og levering

Alt der ændrer din konto kræver `--yes`, så scripts ikke roder i kurven ved et
uheld. `add` lægger til, `set` sætter et absolut antal.

```sh
nemlig basket
nemlig basket add 5035178 2 --yes
nemlig basket set 5035178 3 --yes
nemlig basket remove 5035178 --yes

nemlig orders
nemlig orders show <ordrenummer>

nemlig delivery slots --days 5      # kun ledige tider; --all viser udsolgte
nemlig delivery select <tid-id> --yes
```

## Prissammenligning med goma.gg

`compare` slår hver linje i din kurv op på goma.gg og viser, hvor varen er
billigst uden for nemlig.com. Priser sammenlignes **per kg/liter/stk**, så
forskellige pakkestørrelser kan måles mod hinanden.

```sh
nemlig compare
nemlig compare --store Netto --store Lidl
nemlig goma search kaffe --sale --sort discount
nemlig goma stores
```

Eksempel:

```text
PRODUKT                 NEMLIG          BEDST           BUTIK      SPAR
Bønner grønne øko.      66,67 kr./kg    31,00 kr./kg    Bilka      21,40 kr.
Fusilli                 34,74 kr./kg    11,90 kr./kg    Lidl       11,42 kr.
```

**Vigtigt:** varerne matches på navn og pakkestørrelse, ikke på stregkode.
Linjer markeret med `?` er mindre sikre match. Betragt beløbet som et
overslag — ikke et tilbud.

## Betaling foregår i Firefox

```sh
nemlig checkout status     # tjekker minimumskøb, adresse, leveringstid m.m.
nemlig checkout open
```

CLI'en sender **aldrig** den endelige ordre. Betaling, accept af betingelser og
3-D Secure/MobilePay sker i browseren, hvor du kan se totalen først.

## Indstillinger

| Variabel | Betydning |
| --- | --- |
| `NEMLIG_CONFIG_DIR` | Mappe til `session.json` |
| `NEMLIG_TIMEOUT_MS` | Timeout pr. kald, standard `20000` |
| `NEMLIG_RETRIES` | Forsøg ved 429/5xx, standard `2` |
| `NEMLIG_DEBUG` | Vis fuld fejl-stack |
| `GOMA_API_KEY` | Overskriv goma.gg-nøglen hvis den skiftes |

Exit-koder: `0` ok · `2` ikke logget ind · `3` fejl hos nemlig.com/goma.gg ·
`64` forkert brug.

## Udvikling

```sh
npm test        # 72 tests, ingen netværkskald
npm run check
```

Alle `--json`-flag giver rå JSON til `jq` og scripts.

## Forbehold

Hverken nemlig.com eller goma.gg udgiver disse endpoints som et offentligt,
stabilt API — de kan ændre sig uden varsel. Kortlægningen ligger i
[`docs/network-capture.json`](docs/network-capture.json). goma.gg tilbyder et
officielt Data API for partnere (goma@goma.gg), hvis du har brug for noget, der
er aftalt på skrift. Projektet er ikke tilknyttet nemlig.com eller goma.gg.

MIT-licens.
