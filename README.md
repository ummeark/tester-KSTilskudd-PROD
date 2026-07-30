# tester-KSTilskudd-PROD

Automatiserte tester av produksjonsmiljøet [tilskudd.fiks.ks.no](https://tilskudd.fiks.ks.no/) med Playwright og axe-core.

Testene kjøres daglig på hverdager og publiseres til GitHub Pages:
**https://ummeark.github.io/tester-KSTilskudd-PROD/**

---

## Systemkrav

- **Node.js** v18 eller nyere (testet med v22)
- **macOS** (launchd-automatisering er macOS-spesifikk)
- Internettilgang til tilskudd.fiks.ks.no
- Gyldig innlogging mot produksjonsmiljøet (se `login-prod.js`)

---

## Kom i gang

```bash
# 1. Klon repoet
git clone https://github.com/ummeark/tester-KSTilskudd-PROD.git
cd tester-KSTilskudd-PROD

# 2. Installer avhengigheter (inkludert Playwright Chromium – tar litt tid)
npm install
npx playwright install chromium

# 3. Verifiser at du er i riktig miljø
npm run valider
```

---

## Kjør tester manuelt

```bash
npm run rapport         # WCAG/UU-analyse (axe-core, opptil 20 sider)
npm run monkey          # Monkey-testing (60 tilfeldige handlinger)
npm run sikkerhet       # Sikkerhetstest (hoder, cookies, HTTPS, CORS)
npm run negativ         # Negativ testing (ugyldig input, grenseverdier)
npm run ytelse          # Ytelsesmåling
npm run brukerhistorie  # Brukerhistorietester
```

Rapporter genereres i `rapporter/YYYY-MM-DD/` og åpnes i nettleseren automatisk.

Vil du publisere til arkivsiden på GitHub Pages:

```bash
npm run arkiv        # Kopier rapporter til docs/ og regenerer arkivsiden
git add docs/ && git commit -m "Oppdater rapporter" && git push
```

---

## Innlogging mot produksjon

Produksjonsmiljøet krever manuell innlogging via ID-porten. Kjør dette før testene:

```bash
npm run login-prod   # Åpner nettleser for manuell innlogging – lagrer sesjon til prod-auth.json
```

---

## Automatisk kjøring (macOS launchd)

Testene kjøres automatisk på hverdager via to launchd-jobber:

| Jobb | Tidspunkt | Beskrivelse |
|------|-----------|-------------|
| `no.ks.uu-tester-prod.plist` | 08:30 | Planlagt daglig kjøring |
| `no.ks.uu-tester-prod-vakt.plist` | Hvert 30. min | Starter testene hvis de ikke er kjørt (fanger opp at Mac var avslått) |

Logg: `rapporter/kjoring.log`

---

## Mappestruktur

```
rapporter/YYYY-MM-DD/           Genererte rapporter per dato
  uu-rapport.html               UU-rapport
  monkey-rapport.html           Monkey-rapport
  sikkerhet-rapport.html        Sikkerhetsrapport
  negativ-rapport.html          Negativ testrapport
  ytelse-rapport.html           Ytelsesrapport
  brukerhistorie-rapport.html   Brukerhistorierapport
  resultat.json                 UU-resultater (maskinlesbart)
  monkey-resultat.json          Monkey-resultater
  sikkerhet-resultat.json       Sikkerhetsresultater
  negativ-resultat.json         Negative testresultater
  ytelse-resultat.json          Ytelsesresultater
  brukerhistorie-resultat.json  Brukerhistorieresultater
  skjermbilder/                 Skjermbilder fra UU-test
  skjermbilder-monkey/          Skjermbilder fra monkey-test
  skjermbilder-negativ/         Skjermbilder fra negativ test
  skjermbilder-sikkerhet/       Skjermbilder fra sikkerhetstest

brukerhistorie-resultater/      Mellomlagring for brukerhistorietester
  auth.json                     Innloggingstilstand
  brukerhistorie-resultat.json  Testresultater
  traces/                       Playwright-traces
  skjermbilder/                 Skjermbilder fra feilede tester

docs/                           GitHub Pages
  rapport.html                  Testdashboard (samlet oversikt)
  uu-rapport.html               Siste UU-rapport
  monkey-rapport.html           Siste monkey-rapport
  sikkerhet-rapport.html        Siste sikkerhetsrapport
  negativ-rapport.html          Siste negativ testrapport
  ytelse-rapport.html           Siste ytelsesrapport
  brukerhistorie-rapport.html   Siste brukerhistorierapport
  arkiv.html                    Arkivside med historikk per testtype
  arkiv/YYYY-MM-DD/             Arkiverte rapporter
  admin.html                    Adminside for testdataoversikt
```

---

## Teknisk

- **Browser:** Playwright Chromium (headless), installert lokalt i prosjektet
- **UU-analyse:** axe-core via `@axe-core/playwright`
- **Modulformat:** ES modules (`import`/`export`) — ikke CommonJS
- **Miljøvalidering:** `valider-miljø.sh` og pre-commit hook hindrer krysskontaminering mellom TEST og PROD

---

## Feilsøking

**Playwright finner ikke Chromium:**
```bash
npx playwright install chromium
```

**`valider-miljø.sh` feiler:**
Sjekk at `START_URL` i testfilene peker på produksjonsmiljøet (`tilskudd.fiks.ks.no`), ikke test.

**Testene henger eller timer ut:**
Sjekk at tilskudd.fiks.ks.no er tilgjengelig:
```bash
curl -I https://tilskudd.fiks.ks.no/
```

**Innlogging utløpt:**
Kjør `npm run login-prod` på nytt for å fornye sesjonen i `prod-auth.json`.

---

Se [CLAUDE.md](./CLAUDE.md) for detaljer beregnet på Claude Code-assistenten.
