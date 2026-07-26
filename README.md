# nemlig CLI

Uofficiel kommandolinjeklient til [nemlig.com](https://www.nemlig.com/) med
prissammenligning via [goma.gg](https://goma.gg/).

Søg i varekataloget, hold styr på indkøbskurven, se ordrer og leveringstider —
og få at vide, hvilke varer i kurven der er billigere hos Netto, Lidl, Bilka og
12 andre kæder.

> English reference: [README.en.md](README.en.md)

## Lad din AI-agent stå for indkøbet

Alle kommandoer kan svare med `--json`, alt, der ændrer noget, kræver `--yes`,
og **ingen kommando kan gennemføre et køb**. Tilsammen gør det værktøjet
velegnet til at give en agent — Claude Code, en cron-agent, hvad du nu bruger —
adgang til dine dagligvarer, uden at den kan bruge dine penge.

Giv den fx opgaven:

> *"Se hvad vi købte sidst, fyld kurven med det samme igen, fortæl mig hvad der
> er billigere hos de andre kæder, og reservér en gratis leveringstid til
> weekenden."*

Den kan løse det hele selv:

```sh
nemlig orders --limit 1 --json              # hvad blev der købt sidst?
nemlig orders show <ordrenummer> --json     # de enkelte varelinjer
nemlig basket add <vare-id> <antal> --yes   # fyld kurven op igen
nemlig compare --json                       # hvor er det billigere?
nemlig delivery slots --days 7 --json       # find en tid til 0 kr.
nemlig delivery select <tid-id> --yes
nemlig checkout status                      # mangler der noget?
```

Det sidste skridt kan agenten derimod ikke tage. `checkout open` lægger kurven
op i browseren, og betaling, handelsbetingelser og MobilePay klarer du selv —
efter du har set totalen. Derfor kan du roligt lade en agent gå amok i
varekataloget: det værste, den kan nå, er at fylde din kurv.

## Kom godt i gang

Kræver **Node.js 20 eller nyere**. Virker på macOS, Linux og Windows.

```sh
git clone https://github.com/tobiasdosdal/Nemlig.com-CLI.git
cd Nemlig.com-CLI
npm link          # gør kommandoen "nemlig" tilgængelig overalt
nemlig --help
```

Vil du helst ikke installere den globalt, kan du nøjes med at køre
`node src/cli.js <kommando>`.

## Varekatalog (uden login)

```sh
nemlig search kaffe --limit 5
nemlig suggest kaff
nemlig product 5035178
```

`search` viser det vare-id, som resten af kommandoerne bruger.

## Log ind

```sh
nemlig account login dig@eksempel.dk
nemlig account status
nemlig account logout
```

Adgangskoden skrives skjult og gemmes **aldrig**. Kun session-cookies lægges på
disken, og filen kan kun læses af dig selv:

| Styresystem | Placering |
| --- | --- |
| macOS og Linux | `~/.config/nemlig-cli/session.json` |
| Windows | `%APPDATA%\nemlig-cli\session.json` |

## Kurv, ordrer og levering

Alt, der ændrer din konto, kræver `--yes`, så et script ikke kommer til at rette
i kurven ved et uheld. `add` lægger til det, der allerede ligger i kurven, mens
`set` sætter et bestemt antal.

```sh
nemlig basket
nemlig basket add 5035178 2 --yes     # to mere end du havde
nemlig basket set 5035178 3 --yes     # præcis tre
nemlig basket remove 5035178 --yes

nemlig orders
nemlig orders show <ordrenummer>

nemlig delivery slots --days 5        # kun ledige tider; --all viser de udsolgte
nemlig delivery select <tid-id> --yes
```

## Prissammenligning med goma.gg

`compare` slår hver vare i kurven op på goma.gg og viser, hvor den er billigst
uden for nemlig.com. Priserne regnes om til kilo-, liter- eller stykpris, så
pakker i forskellig størrelse kan sammenlignes.

```sh
nemlig compare
nemlig compare --store Netto --store Lidl
nemlig goma search kaffe --sale --sort discount
nemlig goma stores
```

Sådan ser det ud:

```text
PRODUCT                           NEMLIG           BEST             STORE         SAVE
────────────────────────────────  ───────────────  ───────────────  ────────────  ──────────
Bønner grønne øko.                66,67 kr./kg     31,00 kr./kg     Bilka         21,40 kr.
Fusilli                           34,74 kr./kg     11,90 kr./kg     Lidl          11,42 kr.

Matches:
? Bønner grønne øko. (300 g) → Bilka: Grønne bønner øko (450 g)
  Fusilli (500 g) → Lidl: Combino Fusilli (500 g)

Basket total:      653,46 kr.
Estimated saving:  79,42 kr.

13 of 15 lines matched confidently · 2 unmatched
```

Bemærk, at varerne kædes sammen ud fra navn og størrelse — ikke ud fra
stregkode. Linjer med `?` er usikre match, og de tæller kun med, fordi prisen
per kilo er sammenlignelig; pakken er en anden. Se derfor beløbet som et
overslag, ikke som et tilbud.

## Betalingen foregår i browseren

```sh
nemlig checkout status     # er ordren klar? minimumskøb, adresse, leveringstid
nemlig checkout open
```

CLI'en sender **aldrig** selve bestillingen. Betaling, godkendelse af
handelsbetingelser og 3-D Secure/MobilePay foregår i browseren, hvor du når at
se totalen først.

## Indstillinger

| Variabel | Betydning |
| --- | --- |
| `NEMLIG_CONFIG_DIR` | Mappe til `session.json` |
| `NEMLIG_TIMEOUT_MS` | Hvor længe der ventes på svar, som udgangspunkt `20000` |
| `NEMLIG_RETRIES` | Antal forsøg ved 429/5xx, som udgangspunkt `2` |
| `NEMLIG_DEBUG` | Vis hele fejlsporet |
| `GOMA_API_KEY` | Overskriv goma.gg-nøglen, hvis den bliver skiftet ud |

Kurven forsøges aldrig skrevet to gange, så et gentaget forsøg kan ikke komme
til at fordoble en varelinje.

Afslutningskoder: `0` gik godt · `2` ikke logget ind · `3` fejl hos nemlig.com
eller goma.gg · `64` forkert brug.

## Udvikling

```sh
npm test        # 75 tests, ingen kald ud af huset
npm run check
```

`--json` virker på stort set alle kommandoer og giver rå JSON til `jq` og
scripts:

```sh
nemlig compare --json | jq -r '.rows[] | select(.cheaper) | "\(.saving|floor) kr  \(.line.name)"'
```

## Forbehold

Hverken nemlig.com eller goma.gg udgiver de her endpoints som et offentligt,
stabilt API, så de kan laves om uden varsel. Kortlægningen ligger i
[`docs/network-capture.json`](docs/network-capture.json) og
[`docs/goma-api.json`](docs/goma-api.json). Har du brug for en aftale på skrift,
tilbyder goma.gg et officielt Data API til partnere (goma@goma.gg).

Projektet er hverken tilknyttet nemlig.com eller goma.gg.

MIT-licens.
