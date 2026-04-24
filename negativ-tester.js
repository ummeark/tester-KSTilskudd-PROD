import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { START_URL } from './config.js';
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = path.join(__dirname, 'rapporter', dato);
const skjermDir = path.join(rapportDir, 'skjermbilder-negativ');
fs.mkdirSync(skjermDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;
const startTid = Date.now();

console.log(`\n🧪 Starter negativ testing av: ${START_URL}`);
console.log(`📅 Dato: ${dato}\n`);

// ── Testresultater ────────────────────────────────────────────────────────────

const tester = []; // { kategori, navn, input, forventet, faktisk, resultat, detalj, skjermdump }
let skjermTeller = 0;

function logg(resultat, navn, detalj = '') {
  const ikon = { bestått: '✅', feil: '❌', advarsel: '⚠️' }[resultat] || '⚪';
  console.log(`  ${ikon} ${navn}${detalj ? ` – ${detalj}` : ''}`);
}

// ── Browser ───────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
const nettleser = browser.version();
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 NegativTester/1.0',
  viewport: { width: 1280, height: 900 },
});

// Hent versjonsnummer fra siden
async function hentVersjon(ctx) {
  const p = await ctx.newPage();
  try {
    await p.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const tekst = await p.evaluate(() => document.body.innerText);
    const match = tekst.match(/v\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  } catch { return null; } finally { await p.close(); }
}
const versjon = await hentVersjon(context);

const page = await context.newPage();

const jsErrors = [];
page.on('pageerror', err => jsErrors.push({ melding: err.message, url: page.url() }));

async function skjermdump(prefix) {
  skjermTeller++;
  const filnavn = `negativ-${prefix}-${skjermTeller}.png`;
  try {
    await page.screenshot({ path: path.join(skjermDir, filnavn), fullPage: false });
    return `skjermbilder-negativ/${filnavn}`;
  } catch { return null; }
}

async function gåTil(url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(600);
    return true;
  } catch { return false; }
}

function sjekkFeilmelding(tekst, feilord = ['feil', 'error', 'ugyldig', 'mangler', 'påkrevd', 'required', 'invalid', 'ikke gyldig', 'ikke tillatt']) {
  const lower = tekst.toLowerCase();
  return feilord.some(ord => lower.includes(ord));
}

function sjekkKrasj(tekst) {
  return ['500', 'internal server error', 'something went wrong', 'uventet feil', 'oops'].some(ord => tekst.toLowerCase().includes(ord));
}

async function leggTilTest(kategori, navn, input, forventet, testFn) {
  const jsForFør = jsErrors.length;
  let faktisk = '';
  let resultat = 'bestått';
  let detalj = '';
  let skjerm = null;

  try {
    const res = await testFn();
    faktisk = res?.faktisk || '';
    resultat = res?.resultat || 'bestått';
    detalj = res?.detalj || '';
    skjerm = res?.skjerm || null;
  } catch (e) {
    faktisk = `Unntak: ${e.message.slice(0, 100)}`;
    resultat = 'feil';
    skjerm = await skjermdump('unntak');
  }

  const nyeJsErrors = jsErrors.slice(jsForFør);
  if (nyeJsErrors.length > 0 && resultat === 'bestått') {
    resultat = 'advarsel';
    detalj = (detalj ? detalj + ' · ' : '') + `JS-feil: ${nyeJsErrors[0].melding.slice(0, 80)}`;
    if (!skjerm) skjerm = await skjermdump('js-feil');
  }

  tester.push({ kategori, navn, input, forventet, faktisk, resultat, detalj, skjerm });
  logg(resultat, navn, detalj);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 1: Skjema-validering
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n📝 Kategori 1: Skjema-validering');

// 1a. Tom søk
await leggTilTest('skjema', 'Tom søkeinnsending', '(tomt)', 'Viser feilmelding eller ingen resultatendring', async () => {
  await gåTil(START_URL);
  const søkefelt = await page.$('input[type=search], input[name*=search], input[name*=søk]');
  if (!søkefelt) return { faktisk: 'Søkefelt ikke funnet', resultat: 'advarsel' };
  await søkefelt.fill('');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body');
  const krasj = sjekkKrasj(tekst);
  if (krasj) {
    const skjerm = await skjermdump('tom-søk-krasj');
    return { faktisk: 'Siden krasjet', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Siden håndterte tom søk uten krasj', resultat: 'bestått' };
});

// 1b. Veldig lang søkestreng (2000 tegn)
await leggTilTest('skjema', 'Søk med ekstremt lang tekst (2000 tegn)', 'a'.repeat(2000), 'Håndteres uten krasj', async () => {
  await gåTil(START_URL);
  const søkefelt = await page.$('input[type=search], input[name*=search], input[name*=søk]');
  if (!søkefelt) return { faktisk: 'Søkefelt ikke funnet', resultat: 'advarsel' };
  await søkefelt.fill('a'.repeat(2000));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('lang-tekst-krasj');
    return { faktisk: 'Siden krasjet', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Håndterte lang tekst uten krasj', resultat: 'bestått' };
});

// 1c. Spesialtegn i søk
const spesialtegn = '!@#$%^&*()<>{}[]|\\;:\'",.?/`~';
await leggTilTest('skjema', 'Søk med spesialtegn', spesialtegn, 'Håndteres uten krasj eller XSS', async () => {
  await gåTil(START_URL);
  const søkefelt = await page.$('input[type=search], input[name*=search], input[name*=søk]');
  if (!søkefelt) return { faktisk: 'Søkefelt ikke funnet', resultat: 'advarsel' };
  await søkefelt.fill(spesialtegn);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('spesialtegn-krasj');
    return { faktisk: 'Siden krasjet', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Håndterte spesialtegn uten krasj', resultat: 'bestått' };
});

// 1d. Kun mellomrom i søk
await leggTilTest('skjema', 'Søk med kun mellomrom', '     ', 'Behandles som tom søk eller gir feilmelding', async () => {
  await gåTil(START_URL);
  const søkefelt = await page.$('input[type=search], input[name*=search], input[name*=søk]');
  if (!søkefelt) return { faktisk: 'Søkefelt ikke funnet', resultat: 'advarsel' };
  await søkefelt.fill('     ');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('mellomrom-krasj');
    return { faktisk: 'Siden krasjet', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Håndterte mellomrom uten krasj', resultat: 'bestått' };
});

// 1e. Norske tegn i søk
await leggTilTest('skjema', 'Søk med norske tegn (æøå)', 'æøå ÆØÅ tilskudd', 'Håndteres korrekt', async () => {
  await gåTil(START_URL);
  const søkefelt = await page.$('input[type=search], input[name*=search], input[name*=søk]');
  if (!søkefelt) return { faktisk: 'Søkefelt ikke funnet', resultat: 'advarsel' };
  await søkefelt.fill('æøå ÆØÅ tilskudd');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('norske-tegn-krasj');
    return { faktisk: 'Siden krasjet', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Håndterte norske tegn uten krasj', resultat: 'bestått' };
});

// 1f. SQL-lignende input (ikke angrep, bare validering)
await leggTilTest('skjema', 'SQL-lignende søketekst', "' OR '1'='1", 'Renses og vises trygt', async () => {
  await gåTil(START_URL);
  const søkefelt = await page.$('input[type=search], input[name*=search], input[name*=søk]');
  if (!søkefelt) return { faktisk: 'Søkefelt ikke funnet', resultat: 'advarsel' };
  await søkefelt.fill("' OR '1'='1");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('sql-krasj');
    return { faktisk: 'Siden krasjet – mulig SQL-feil i svar', resultat: 'feil', skjerm };
  }
  return { faktisk: 'SQL-lignende input håndtert uten krasj', resultat: 'bestått' };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 2: URL-validering
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n🔗 Kategori 2: URL-validering');

const ugyldigeUrler = [
  { sti: '/finnesikke',                     beskrivelse: 'Ukjent side' },
  { sti: '/ordninger/ikke-en-gyldig-uuid',  beskrivelse: 'Ugyldig UUID i URL' },
  { sti: '/ordninger/00000000-0000-0000-0000-000000000000', beskrivelse: 'Null-UUID' },
  { sti: '/ordninger/../admin',             beskrivelse: 'Path traversal-forsøk' },
  { sti: '/%2e%2e%2fadmin',                beskrivelse: 'Kodet path traversal' },
  { sti: '/søknad/opprett/ugyldigid',      beskrivelse: 'Ugyldig søknads-ID' },
];

for (const { sti, beskrivelse } of ugyldigeUrler) {
  await leggTilTest('url', beskrivelse, baseOrigin + sti, 'Viser 404-side eller feilmelding – ikke krasj', async () => {
    const lastet = await gåTil(baseOrigin + sti);
    const tekst = await page.textContent('body').catch(() => '');
    const status = page.url();
    const krasj = sjekkKrasj(tekst);

    if (krasj) {
      const skjerm = await skjermdump('url-krasj');
      return { faktisk: 'Siden krasjet (500 eller uventet feil)', resultat: 'feil', detalj: `URL: ${sti}`, skjerm };
    }
    if (tekst.includes('404') || tekst.toLowerCase().includes('ikke funnet') || tekst.toLowerCase().includes('not found')) {
      return { faktisk: 'Viser 404-side korrekt', resultat: 'bestått' };
    }
    // Omdirigerte til en annen side – akseptabelt
    if (status !== baseOrigin + sti) {
      return { faktisk: `Omdirigerte til: ${status}`, resultat: 'bestått' };
    }
    const skjerm = await skjermdump('url-ingen-feilside');
    return { faktisk: 'Ingen tydelig feilhåndtering', resultat: 'advarsel', skjerm };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 3: Navigasjonsrekkefølge
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n🔀 Kategori 3: Navigasjonsrekkefølge');

// 3a. Direkte tilgang til søknadsskjema
await leggTilTest('navigasjon', 'Direkte tilgang til søknadsskjema uten forside', '/soknad/opprett', 'Håndteres – viser skjema eller omdirigerer', async () => {
  await gåTil(baseOrigin + '/soknad/opprett');
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('soknad-direkte-krasj');
    return { faktisk: 'Siden krasjet', resultat: 'feil', skjerm };
  }
  return { faktisk: `Lastet uten krasj (URL: ${page.url()})`, resultat: 'bestått' };
});

// 3b. Tilbake-knapp etter søknad
await leggTilTest('navigasjon', 'Browser tilbake fra søknadsskjema', 'goBack()', 'Håndteres uten krasj', async () => {
  await gåTil(START_URL);
  await gåTil(baseOrigin + '/soknad/opprett');
  await page.goBack({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('tilbake-krasj');
    return { faktisk: 'Siden krasjet etter tilbake-navigasjon', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Tilbake-navigasjon håndtert uten krasj', resultat: 'bestått' };
});

// 3c. Rask frem-og-tilbake navigasjon
await leggTilTest('navigasjon', 'Rask frem-og-tilbake-navigasjon (5x)', '5x goBack/goForward', 'Ingen krasj', async () => {
  await gåTil(START_URL);
  await gåTil(baseOrigin + '/ordninger');
  for (let i = 0; i < 5; i++) {
    await page.goBack({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
    await page.goForward({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('rask-nav-krasj');
    return { faktisk: 'Krasjet under rask navigasjon', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Rask navigasjon håndtert uten krasj', resultat: 'bestått' };
});

// 3d. Dobbelt-klikk på knapp
await leggTilTest('navigasjon', 'Dobbelt-klikk på handlingsknapp', 'dblclick', 'Ingen dobbel-innsending eller krasj', async () => {
  await gåTil(START_URL);
  const knapp = await page.$('button:visible');
  if (!knapp) return { faktisk: 'Ingen knapp funnet', resultat: 'advarsel' };
  await knapp.dblclick({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('dblclick-krasj');
    return { faktisk: 'Krasjet ved dobbelt-klikk', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Dobbelt-klikk håndtert uten krasj', resultat: 'bestått' };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 4: Nettleserfunksjoner
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n🌐 Kategori 4: Nettleserfunksjoner');

// 4a. Refresh midt i flyt
await leggTilTest('nettleser', 'Sideoppdatering (F5) under søknad', 'reload()', 'Håndteres – viser skjema eller forklaring', async () => {
  await gåTil(baseOrigin + '/soknad/opprett');
  await page.reload({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(600);
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('reload-krasj');
    return { faktisk: 'Krasjet etter reload', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Reload håndtert uten krasj', resultat: 'bestått' };
});

// 4b. JavaScript deaktivert (ny kontekst)
await leggTilTest('nettleser', 'Siden uten JavaScript', 'noScript', 'Viser innhold eller tydelig feilmelding', async () => {
  const noJsCtx = await browser.newContext({ javaScriptEnabled: false });
  const noJsPage = await noJsCtx.newPage();
  try {
    await noJsPage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const tekst = await noJsPage.textContent('body').catch(() => '');
    const harInnhold = tekst.trim().length > 100;
    await noJsCtx.close();
    if (!harInnhold) {
      const skjerm = await skjermdump('no-js-tom');
      return { faktisk: 'Siden er tom uten JavaScript', resultat: 'advarsel', skjerm };
    }
    return { faktisk: 'Siden viser innhold uten JavaScript', resultat: 'bestått' };
  } catch (e) {
    await noJsCtx.close();
    return { faktisk: `Feil: ${e.message.slice(0, 80)}`, resultat: 'advarsel' };
  }
});

// 4c. Mobilvisning (320px)
await leggTilTest('nettleser', 'Smal mobilvisning (320px bredde)', '320px viewport', 'Ingen krasj, siden er brukbar', async () => {
  const mobilCtx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const mobilPage = await mobilCtx.newPage();
  try {
    await mobilPage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const tekst = await mobilPage.textContent('body').catch(() => '');
    if (sjekkKrasj(tekst)) {
      await mobilCtx.close();
      return { faktisk: 'Krasjet på mobilvisning', resultat: 'feil' };
    }
    const skjerm = await (async () => {
      skjermTeller++;
      const fn = `negativ-mobil-${skjermTeller}.png`;
      await mobilPage.screenshot({ path: path.join(skjermDir, fn) }).catch(() => {});
      return `skjermbilder-negativ/${fn}`;
    })();
    await mobilCtx.close();
    return { faktisk: 'Siden lastet på 320px uten krasj', resultat: 'bestått', skjerm };
  } catch (e) {
    await mobilCtx.close();
    return { faktisk: `Feil: ${e.message.slice(0, 80)}`, resultat: 'advarsel' };
  }
});

// 4d. Veldig stor viewport (4K)
await leggTilTest('nettleser', 'Stor skjerm (3840×2160)', '4K viewport', 'Ingen krasj, layout er stabil', async () => {
  const storCtx = await browser.newContext({ viewport: { width: 3840, height: 2160 } });
  const storPage = await storCtx.newPage();
  try {
    await storPage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const tekst = await storPage.textContent('body').catch(() => '');
    await storCtx.close();
    if (sjekkKrasj(tekst)) return { faktisk: 'Krasjet på 4K-visning', resultat: 'feil' };
    return { faktisk: 'Siden lastet på 4K uten krasj', resultat: 'bestått' };
  } catch (e) {
    await storCtx.close();
    return { faktisk: `Feil: ${e.message.slice(0, 80)}`, resultat: 'advarsel' };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 5: Tilstand og sesjon
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n🔑 Kategori 5: Tilstand og sesjon');

// 5a. Slette alle cookies og laste siden
await leggTilTest('sesjon', 'Last side etter sletting av alle cookies', 'clearCookies()', 'Siden laster – viser innloggingsside eller offentlig innhold', async () => {
  await gåTil(START_URL);
  await context.clearCookies();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('no-cookies-krasj');
    return { faktisk: 'Krasjet uten cookies', resultat: 'feil', skjerm };
  }
  return { faktisk: `Siden lastet uten cookies (URL: ${page.url()})`, resultat: 'bestått' };
});

// 5b. LocalStorage tømt
await leggTilTest('sesjon', 'Last side etter tømming av localStorage', 'localStorage.clear()', 'Siden laster – ingen krasj', async () => {
  await gåTil(START_URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch(e) {} });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);
  const tekst = await page.textContent('body').catch(() => '');
  if (sjekkKrasj(tekst)) {
    const skjerm = await skjermdump('no-localstorage-krasj');
    return { faktisk: 'Krasjet etter localStorage.clear()', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Siden lastet uten localStorage uten krasj', resultat: 'bestått' };
});

// 5c. Tilgang til beskyttet side uten sesjon
await leggTilTest('sesjon', 'Direkte tilgang til "Min side" uten innlogging', '/minside', 'Omdirigerer til innlogging – ikke krasj', async () => {
  const nyCtx = await browser.newContext();
  const nyPage = await nyCtx.newPage();
  try {
    await nyPage.goto(baseOrigin + '/minside', { waitUntil: 'domcontentloaded', timeout: 12000 });
    await nyPage.waitForTimeout(600);
    const url = nyPage.url();
    const tekst = await nyPage.textContent('body').catch(() => '');
    await nyCtx.close();
    if (sjekkKrasj(tekst)) return { faktisk: 'Krasjet', resultat: 'feil' };
    if (url.includes('login') || url.includes('logg-inn') || url.includes('innlogging') || url.includes('auth')) {
      return { faktisk: `Omdirigerte til innlogging: ${url}`, resultat: 'bestått' };
    }
    const skjerm = await skjermdump('minside-uten-auth');
    return { faktisk: `Landet på: ${url} – sjekk om innhold er beskyttet`, resultat: 'advarsel', skjerm };
  } catch (e) {
    await nyCtx.close();
    return { faktisk: `Feil: ${e.message.slice(0, 80)}`, resultat: 'advarsel' };
  }
});

await browser.close();

// ── Oppsummering ──────────────────────────────────────────────────────────────

const varighet = Math.round((Date.now() - startTid) / 1000);
const bestått  = tester.filter(t => t.resultat === 'bestått').length;
const feil     = tester.filter(t => t.resultat === 'feil').length;
const advarsel = tester.filter(t => t.resultat === 'advarsel').length;

const score = Math.max(0, 100 - feil * 15 - advarsel * 5);
const scoreKlasse = score >= 80 ? 'god' : score >= 50 ? 'middels' : 'dårlig';

console.log(`\n${'━'.repeat(60)}`);
console.log(`🧪 NEGATIV-TESTRAPPORT – ${START_URL}`);
console.log('━'.repeat(60));
console.log(`✅ Bestått:   ${bestått}`);
console.log(`⚠️  Advarsler: ${advarsel}`);
console.log(`❌ Feil:      ${feil}`);
console.log(`📊 Score:     ${score}/100`);
console.log(`⏱️  Varighet:  ${varighet}s`);
console.log('━'.repeat(60));

fs.writeFileSync(
  path.join(rapportDir, 'negativ-resultat.json'),
  JSON.stringify({ url: START_URL, dato, versjon, nettleser, score, totalt: { bestått, feil, advarsel, totalt: tester.length, varighet }, tester }, null, 2)
);

// ── HTML-rapport ──────────────────────────────────────────────────────────────

const KATEGORIER = {
  skjema:    { tittel: 'Skjema-validering',      ikon: '📝' },
  url:       { tittel: 'URL-validering',          ikon: '🔗' },
  navigasjon:{ tittel: 'Navigasjonsrekkefølge',  ikon: '🔀' },
  nettleser: { tittel: 'Nettleserfunksjoner',     ikon: '🌐' },
  sesjon:    { tittel: 'Tilstand og sesjon',      ikon: '🔑' },
};

const perKategori = {};
for (const t of tester) {
  if (!perKategori[t.kategori]) perKategori[t.kategori] = [];
  perKategori[t.kategori].push(t);
}

const sidenavigasjon = Object.entries(KATEGORIER).map(([id, { tittel, ikon }]) => {
  const ktester = perKategori[id] || [];
  const harFeil = ktester.some(t => t.resultat === 'feil');
  const harAdv  = ktester.some(t => t.resultat === 'advarsel');
  const klasse  = harFeil ? 'har-kritiske' : harAdv ? 'har-brudd' : 'ok';
  const feil    = ktester.filter(t => t.resultat !== 'bestått').length;
  return `<li><a href="#${id}" class="sidenav-link ${klasse}">
    <span class="sidenavn">${ikon} ${tittel}</span>
    <span class="side-badge">${ktester.length} tester · ${feil > 0 ? feil + ' feil/adv.' : '✅ alle bestått'}</span>
  </a></li>`;
}).join('');

function testKort(t) {
  const farger = { bestått: '#07604f', feil: '#c53030', advarsel: '#b8860b' };
  const ikoner = { bestått: '✅', feil: '❌', advarsel: '⚠️' };
  return `
  <div class="brudd-kort" style="border-left-color:${farger[t.resultat] || '#6b7280'}">
    <div class="brudd-header">
      <div>
        <span class="badge ${t.resultat}">${ikoner[t.resultat]} ${t.resultat}</span>
        <span class="regel-desc">${t.navn}</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin:.5rem 0;font-size:.8rem">
      <div style="background:#f4ecdf;padding:.4rem .6rem">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:.2rem">Input</div>
        <div style="color:#374151;word-break:break-all">${t.input}</div>
      </div>
      <div style="background:${t.resultat === 'bestått' ? '#ecfdf5' : t.resultat === 'feil' ? '#fee2e2' : '#fff9db'};padding:.4rem .6rem">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:.2rem">Faktisk oppførsel</div>
        <div style="color:#374151;word-break:break-all">${t.faktisk || t.forventet}</div>
      </div>
    </div>
    ${t.detalj ? `<p class="brudd-hjelp">${t.detalj}</p>` : ''}
    ${t.skjerm ? `
    <div class="skjermdump-gruppe">
      <div class="skjermdump-wrapper">
        <p class="skjermdump-label">Skjermdump</p>
        <a href="${t.skjerm}" target="_blank">
          <img src="${t.skjerm}" alt="Skjermdump" class="skjermdump helside" loading="lazy">
        </a>
      </div>
    </div>` : ''}
  </div>`;
}

const seksjoner = Object.entries(KATEGORIER).map(([id, { tittel, ikon }]) => {
  const ktester = perKategori[id] || [];
  return `
  <div class="seksjon" id="${id}">
    <div class="seksjon-tittel">${ikon} ${tittel} – ${ktester.filter(t=>t.resultat==='bestått').length}/${ktester.length} bestått</div>
    ${ktester.length === 0 ? '<div class="wcag-ok">Ingen tester i denne kategorien</div>' : ktester.map(testKort).join('')}
  </div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Negativ testrapport – ${dato} ${tidspunkt}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#faf6f0;color:#0f0e17;display:flex;min-height:100vh}
  .sidemeny{width:272px;min-width:272px;background:#07604f;color:white;padding:0;overflow-y:auto;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
  .sidemeny-header{padding:1.2rem 1.4rem;border-bottom:1px solid rgba(255,255,255,.1)}
  .sidemeny-logo{font-size:.7rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;opacity:.45;margin-bottom:.5rem}
  .env-badge{display:inline-block;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;background:rgba(255,255,255,.18);color:white;padding:.25rem .7rem;border-radius:100px;margin-top:.5rem}
  .sidemeny h1{font-size:.95rem;font-weight:600;line-height:1.3}
  .sidemeny h1 span{display:block;font-size:.72rem;opacity:.45;margin-top:.3rem;font-weight:400}
  .sidemeny ul{list-style:none;flex:1;overflow-y:auto;padding:.5rem 0}
  .sidenav-link{display:block;padding:.65rem 1.4rem;text-decoration:none;color:rgba(255,255,255,.65);border-left:3px solid transparent;transition:background .15s,color .15s}
  .sidenav-link:hover{background:rgba(255,255,255,.07);color:white}
  .sidenav-link.har-kritiske{border-color:#fc8181}
  .sidenav-link.har-brudd{border-color:#f3dda2}
  .sidenav-link.ok{border-color:#abd1b1}
  .sidenavn{display:block;font-size:.84rem;font-weight:500}
  .side-badge{display:block;font-size:.68rem;margin-top:.2rem;opacity:.6}
  .hoveddel{flex:1;padding:2.5rem 3rem;overflow-y:auto;max-width:1060px}
  .rapport-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:2rem;padding-bottom:1.5rem;border-bottom:2px solid #f4ecdf;flex-wrap:wrap}
  .rapport-header h1{font-size:1.5rem;font-weight:700;color:#0a1355;letter-spacing:-.01em}
  .rapport-header .meta{font-size:.85rem;color:#6b7280;margin-top:.4rem}
  .rapport-header .meta a{color:#07604f;text-decoration:none}
  .nav-knapper{display:flex;gap:.6rem;flex-wrap:wrap;align-items:flex-start}
  .knapp{display:inline-block;padding:.5rem 1.2rem;background:#07604f;color:white;border-radius:100px;font-size:.82rem;font-weight:500;text-decoration:none;white-space:nowrap;transition:background .15s}
  .knapp:hover{background:#2b3285}
  .knapp.aktiv{background:#07604f;pointer-events:none}
  .knapp.sekundær{background:transparent;border:1px solid #0a1355;color:#0a1355}
  .knapp.sekundær:hover{background:#f4ecdf}
  .score-kort{background:white;border:1px solid #f1f0ee;padding:1.8rem 2rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .score-sirkel{width:88px;height:88px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:700;flex-shrink:0}
  .score-sirkel.god{background:#07604f;color:white}
  .score-sirkel.middels{background:#f3dda2;color:#0a1355}
  .score-sirkel.dårlig{background:#c53030;color:white}
  .score-tekst strong{color:#0a1355;font-size:1rem}
  .score-tekst p{color:#6b7280;font-size:.87rem;margin-top:.35rem;line-height:1.5}
  .kort-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.8rem;margin-bottom:2rem}
  .kort{background:white;padding:1.2rem 1rem;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .kort.kritisk{border-left-color:#c53030}.kort.advarsel{border-left-color:#b8860b}.kort.ok{border-left-color:#07604f}.kort.nøytral{border-left-color:#2b3285}
  .kort .tall{font-size:2rem;font-weight:700;margin:.3rem 0;color:#0a1355}
  .kort .etikett{font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .seksjon-tittel{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid #f4ecdf}
  .brudd-kort{background:#faf6f0;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;padding:1rem 1.1rem;margin-bottom:.7rem}
  .brudd-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.5rem;gap:.5rem;flex-wrap:wrap}
  .regel-desc{font-size:.84rem;color:#374151}
  .brudd-hjelp{font-size:.82rem;color:#555;margin:.6rem 0;padding:.5rem .8rem;background:#f4ecdf;border-left:3px solid #b8860b;word-break:break-all}
  .node-info{background:#f1f0ee;padding:.5rem .7rem;margin:.4rem 0}
  .node-selector{display:block;color:#2b3285;font-family:ui-monospace,monospace;word-break:break-all;font-size:.78rem}
  .skjermdump-gruppe{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:.9rem}
  .skjermdump-wrapper{background:#f1f0ee;padding:.7rem}
  .skjermdump-label{font-size:.68rem;color:#6b7280;margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}
  .skjermdump{width:100%;border:1px solid #e5e3de;cursor:zoom-in;transition:box-shadow .2s;display:block}
  .skjermdump:hover{box-shadow:0 4px 16px rgba(10,19,85,.15)}
  .helside{max-height:300px;object-fit:cover;object-position:top}
  .badge{display:inline-block;padding:.15rem .6rem;border-radius:100px;font-size:.7rem;font-weight:600;margin-right:.3rem}
  .badge.bestått{background:#ecfdf5;color:#07604f}
  .badge.feil{background:#fee2e2;color:#c53030}
  .badge.advarsel{background:#f3dda2;color:#713f12}
  .wcag-ok{background:#ecfdf5;color:#064e3b;padding:.8rem 1rem;border-left:3px solid #07604f;font-size:.88rem}
  footer{text-align:center;padding:2.5rem;color:#9ca3af;font-size:.78rem;border-top:1px solid #f1f0ee;margin-top:2rem}
</style>
</head>
<body>
<nav class="sidemeny">
  <div class="sidemeny-header">
    <div class="sidemeny-logo">KS Tilskudd · Negativ testing</div>
    <div class="env-badge">PRODUKSJON${versjon ? ` · ${versjon}` : ''}</div>
    <h1>Negativ testrapport <span>${dato} ${tidspunkt} · ${tester.length} tester</span></h1>
  </div>
  <ul>${sidenavigasjon}</ul>
</nav>
<div class="hoveddel">
  <div class="rapport-header">
    <div>
      <h1>Negativ testrapport</h1>
      <div class="meta"><a href="${START_URL}" target="_blank">${START_URL}</a> · ${dato} ${tidspunkt} · ${tester.length} tester · ${varighet}s · Chromium ${nettleser.split('.')[0]}</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp sekundær">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp aktiv">Negativ test</a>
      <a href="ytelse-rapport.html" class="knapp sekundær">Ytelsestest</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
    </div>
  </div>

  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er negativ testing?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      Negativ testing sjekker at applikasjonen håndterer ugyldige, uventede og grensetilfelle-inputs
      på en kontrollert og brukervennlig måte – uten krasj, feilsider eller utilsiktet oppførsel.
      Testene er strukturerte og ikke-destruktive.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva testes</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>📝 Skjema med ugyldig input</li>
          <li>🔗 Ikke-eksisterende og ugyldige URL-er</li>
          <li>🔀 Uventet navigasjonsrekkefølge</li>
          <li>🌐 Nettleserbegrensninger (ingen JS, mobil)</li>
          <li>🔑 Sesjon og tilstandshåndtering</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva måles</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Krasjer siden (500, JS-feil)?</li>
          <li>Vises tydelig feilmelding?</li>
          <li>Beholdes brukeren i kontroll?</li>
          <li>Håndteres edge cases trygt?</li>
          <li>Omdirigerer auth korrekt?</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Testresultater</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>✅ Bestått – håndtert korrekt</li>
          <li>⚠️ Advarsel – håndtert, men mangler</li>
          <li>❌ Feil – krasj eller utilsiktet oppf.</li>
          <li>Playwright (ekte nettleser)</li>
          <li>Daglig kjøring kl. 08:30</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="score-kort">
    <div class="score-sirkel ${scoreKlasse}">${score}</div>
    <div class="score-tekst">
      <strong>Robusthetsscore</strong>
      <p>${bestått} av ${tester.length} tester bestått. ${feil} feil og ${advarsel} advarsler på tvers av ${Object.keys(KATEGORIER).length} testkategorier.</p>
    </div>
  </div>

  <div class="kort-grid">
    <div class="kort ok"><div class="tall">${tester.length}</div><div class="etikett">Tester totalt</div></div>
    <div class="kort ok"><div class="tall">${bestått}</div><div class="etikett">Bestått</div></div>
    <div class="kort ${advarsel > 0 ? 'advarsel' : 'ok'}"><div class="tall">${advarsel}</div><div class="etikett">Advarsler</div></div>
    <div class="kort ${feil > 0 ? 'kritisk' : 'ok'}"><div class="tall">${feil}</div><div class="etikett">Feil</div></div>
  </div>

  ${seksjoner}

  <div class="seksjon" style="margin-top:2rem">
    <div class="seksjon-tittel">Slik beregnes robusthetssscoren</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">Feil</span><span style="color:#c53030;font-weight:700">× 15 poeng</span>
      <span style="color:#374151">Advarsel</span><span style="color:#9a3412;font-weight:700">× 5 poeng</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Score = maks(0, 100 − sum av trekk) &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>
  <details style="margin-top:2rem;border:1px solid #e5e3de;border-radius:.5rem;padding:1rem 1.2rem;background:#fafaf9">
    <summary style="cursor:pointer;font-size:.88rem;font-weight:600;color:#374151;user-select:none">Alle tester som kjøres (${tester.length}) ▾</summary>
    <div style="margin-top:1rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.2rem;font-size:.82rem">
      ${(() => {
        const navnMap = { skjema:'Skjema', url:'URL-manipulering', navigasjon:'Navigasjon', nettleser:'Nettleser', sesjon:'Sesjon' };
        const kategorier = [...new Set(tester.map(t => t.kategori))];
        return kategorier.map(kat => `
          <div>
            <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem">${navnMap[kat] || kat}</div>
            <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
              ${tester.filter(t => t.kategori === kat).map(t => `<li style="color:#374151">· ${t.navn}</li>`).join('')}
            </ul>
          </div>`).join('');
      })()}
    </div>
  </details>
  <footer>KS Tilskudd · Negativ testing · Playwright · ${dato} ${tidspunkt}</footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(rapportDir, 'negativ-rapport.html'), html);

// Lagre tidsstemplet kopi for arkiv (bevarer alle kjøringer samme dag)
const tidFil = tidspunkt.replace(':', '-');
fs.copyFileSync(path.join(rapportDir, 'negativ-resultat.json'), path.join(rapportDir, `negativ-resultat-${tidFil}.json`));
fs.copyFileSync(path.join(rapportDir, 'negativ-rapport.html'), path.join(rapportDir, `negativ-rapport-${tidFil}.html`));

console.log(`\n📁 Negativ-rapport: ${path.join(rapportDir, 'negativ-rapport.html')}`);
exec(`open "${path.join(rapportDir, 'negativ-rapport.html')}"`);
