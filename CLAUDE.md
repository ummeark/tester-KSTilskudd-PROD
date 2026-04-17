# tester-KSTilskudd-prod

Automatiserte tester av [tilskudd.fiks.ks.no](https://tilskudd.fiks.ks.no/) med Playwright og axe-core.

## Testene

| Kommando | Fil | Beskrivelse |
|----------|-----|-------------|
| `npm run rapport` | `uu-tester.js` | WCAG/UU-analyse med axe-core, crawler opptil 20 sider |
| `npm run monkey` | `monkey-tester.js` | Monkey-testing, 60 tilfeldige handlinger |
| `npm run sikkerhet` | `sikkerhet-tester.js` | Sikkerhetstest (hoder, cookies, HTTPS, CORS osv.) |
| `npm run negativ` | `negativ-tester.js` | Negativ testing (ugyldig input, URL-manipulering osv.) |
| `npm run arkiv` | `generer-arkiv.js` | Regenerer arkivsiden og kopier rapporter til docs/ |

## Mappestruktur

```
rapporter/YYYY-MM-DD/       Genererte rapporter per dato
  rapport.html              UU-rapport
  monkey-rapport.html       Monkey-rapport
  sikkerhet-rapport.html    Sikkerhetsrapport
  negativ-rapport.html      Negativ testrapport
  resultat.json             UU-resultater (maskinlesbart)
  monkey-resultat.json      Monkey-resultater
  sikkerhet-resultat.json   Sikkerhetsresultater
  negativ-resultat.json     Negative testresultater
  skjermbilder/             Skjermbilder fra UU-test
  skjermbilder-monkey/      Skjermbilder fra monkey-test
  skjermbilder-negativ/     Skjermbilder fra negativ test
  skjermbilder-sikkerhet/   Skjermbilder fra sikkerhetstest

docs/                       GitHub Pages (ummeark.github.io/tester-KSTilskudd-prod-prod/)
  rapport.html              Siste UU-rapport
  monkey-rapport.html       Siste monkey-rapport
  sikkerhet-rapport.html    Siste sikkerhetsrapport
  negativ-rapport.html      Siste negativ testrapport
  arkiv.html                Arkivside med historikk per testtype
  arkiv/YYYY-MM-DD/         Arkiverte rapporter
```

## Teknisk

- **Browser:** Playwright Chromium (headless), versjon 1.59.1, installert lokalt i prosjektet
- **UU-analyse:** axe-core via `@axe-core/playwright`
- **Rapporter:** HTML generert direkte fra testfilene, kopieres til `docs/` for GitHub Pages
- **Dato og klokkeslett:** Alle rapporter viser `YYYY-MM-DD HH:MM` i tittel, header, meta og footer

## Viktig å huske

- Kjør alltid `npm run arkiv` etter at tester er kjørt og rapporter skal publiseres til arkivsiden
- Ikke endre mappenavnet `docs/` — GitHub Pages er konfigurert til å serve derfra
- Testfilene bruker ES modules (`import`/`export`), ikke CommonJS
