import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_URL = process.argv[2] || 'https://tilskudd.fiks.ks.no/';
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = path.join(__dirname, 'rapporter', dato);
const skjermDir = path.join(rapportDir, 'skjermbilder-sikkerhet');
fs.mkdirSync(skjermDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;
const startTid = Date.now();

console.log(`\n🔐 Starter sikkerhetstest av: ${START_URL}`);
console.log(`📅 Dato: ${dato}\n`);

// ── Konfigurasjon ─────────────────────────────────────────────────────────────

const SIKKERHETSHODER = {
  'strict-transport-security':    { navn: 'HSTS',                 alvorlighet: 'kritisk', beskrivelse: 'Tvinger HTTPS og beskytter mot downgrade-angrep' },
  'content-security-policy':      { navn: 'Content-Security-Policy', alvorlighet: 'alvorlig', beskrivelse: 'Begrenser hvilke ressurser siden kan laste og kjøre' },
  'x-frame-options':              { navn: 'X-Frame-Options',      alvorlighet: 'alvorlig', beskrivelse: 'Beskytter mot clickjacking via iframe-innramming' },
  'x-content-type-options':       { navn: 'X-Content-Type-Options', alvorlighet: 'middels', beskrivelse: 'Hindrer MIME-type sniffing i nettleseren' },
  'referrer-policy':              { navn: 'Referrer-Policy',      alvorlighet: 'lav',      beskrivelse: 'Kontrollerer referrer-informasjon i forespørsler' },
  'permissions-policy':           { navn: 'Permissions-Policy',   alvorlighet: 'lav',      beskrivelse: 'Begrenser tilgang til nettleserfunksjoner (kamera, GPS osv.)' },
  'cross-origin-opener-policy':   { navn: 'COOP',                 alvorlighet: 'lav',      beskrivelse: 'Isolerer nettleservinduet mot cross-origin-angrep' },
  'cross-origin-resource-policy': { navn: 'CORP',                 alvorlighet: 'lav',      beskrivelse: 'Begrenser hvem som kan laste inn sidens ressurser' },
};

const SENSITIVE_STIER = [
  { sti: '/.env',              beskrivelse: 'Miljøvariabelfil med hemmeligheter' },
  { sti: '/.env.local',        beskrivelse: 'Lokal miljøvariabelfil' },
  { sti: '/.env.production',   beskrivelse: 'Produksjonsmiljøvariabelfil' },
  { sti: '/config.json',       beskrivelse: 'Konfigurasjonsfil' },
  { sti: '/.git/config',       beskrivelse: 'Git-repositorykonfigurasjon' },
  { sti: '/.git/HEAD',         beskrivelse: 'Git HEAD-referanse' },
  { sti: '/api',               beskrivelse: 'API-rotendepunkt' },
  { sti: '/api/v1',            beskrivelse: 'API versjon 1' },
  { sti: '/api/health',        beskrivelse: 'Helsesjekk-endepunkt' },
  { sti: '/api/config',        beskrivelse: 'API-konfigurasjon' },
  { sti: '/actuator',          beskrivelse: 'Spring Boot Actuator' },
  { sti: '/actuator/health',   beskrivelse: 'Spring Boot helsesjekk' },
  { sti: '/actuator/env',      beskrivelse: 'Spring Boot miljøinfo' },
  { sti: '/swagger-ui.html',   beskrivelse: 'Swagger API-dokumentasjon' },
  { sti: '/openapi.json',      beskrivelse: 'OpenAPI-spesifikasjon' },
  { sti: '/graphql',           beskrivelse: 'GraphQL-endepunkt' },
  { sti: '/admin',             beskrivelse: 'Administrasjonsgrensesnitt' },
  { sti: '/robots.txt',        beskrivelse: 'Robot-eksklusjonsfil' },
  { sti: '/sitemap.xml',       beskrivelse: 'Sitemap (informasjonslekkasje)' },
];

const INFO_LEKKASJE_HODER = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator'];

const XSS_PAYLOAD = '<script>window.__xsstest=1</script>';
const XSS_SØKEFELT_PAYLOAD = '"><img src=x onerror=alert(1)>';

// ── Hjelpefunksjoner ──────────────────────────────────────────────────────────

function hentHoder(url) {
  return new Promise((resolve) => {
    const modul = url.startsWith('https') ? https : http;
    const req = modul.request(url, { method: 'HEAD', timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 SikkerhetsTester/1.0' },
      rejectUnauthorized: false,
    }, res => resolve({ status: res.statusCode, hoder: res.headers }));
    req.on('error', () => resolve({ status: 0, hoder: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, hoder: {} }); });
    req.end();
  });
}

function hentInnhold(url) {
  return new Promise((resolve) => {
    const modul = url.startsWith('https') ? https : http;
    let data = '';
    const req = modul.request(url, { method: 'GET', timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 SikkerhetsTester/1.0' },
      rejectUnauthorized: false,
    }, res => {
      res.on('data', chunk => { data += chunk; if (data.length > 50000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, hoder: res.headers, innhold: data }));
    });
    req.on('error', () => resolve({ status: 0, hoder: {}, innhold: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, hoder: {}, innhold: '' }); });
    req.end();
  });
}

let skjermTeller = 0;
async function taSkjermdump(page, prefix) {
  skjermTeller++;
  const filnavn = `sikkerhet-${prefix}-${skjermTeller}.png`;
  try {
    await page.screenshot({ path: path.join(skjermDir, filnavn), fullPage: false });
    return `skjermbilder-sikkerhet/${filnavn}`;
  } catch { return null; }
}

// ── Resultatlagring ───────────────────────────────────────────────────────────

const funn = [];

function leggTilFunn(kategori, alvorlighet, tittel, detalj, url = START_URL, ekstra = {}) {
  funn.push({ kategori, alvorlighet, tittel, detalj, url, ...ekstra });
  const ikon = { kritisk: '🔴', alvorlig: '🟠', middels: '🟡', lav: '🔵', ok: '✅' }[alvorlighet] || '⚪';
  console.log(`  ${ikon} [${alvorlighet.toUpperCase()}] ${tittel}`);
}

// ── Test 1: HTTP-sikkerhetshoder ──────────────────────────────────────────────

console.log('📋 Sjekker HTTP-sikkerhetshoder...');
const { hoder: hoved_hoder, status: hoved_status } = await hentHoder(START_URL);

for (const [header, info] of Object.entries(SIKKERHETSHODER)) {
  if (!hoved_hoder[header]) {
    leggTilFunn('hoder', info.alvorlighet,
      `Manglende ${info.navn}`,
      info.beskrivelse,
      START_URL
    );
  } else {
    leggTilFunn('hoder', 'ok',
      `${info.navn} er satt`,
      `Verdi: ${hoved_hoder[header]}`,
      START_URL
    );
  }
}

// ── Test 2: Informasjonslekkasje i hoder ─────────────────────────────────────

console.log('🕵️  Sjekker informasjonslekkasje i hoder...');
for (const header of INFO_LEKKASJE_HODER) {
  if (hoved_hoder[header]) {
    leggTilFunn('informasjonslekkasje', 'middels',
      `Server avslører teknologiinformasjon: ${header}`,
      `Verdi: "${hoved_hoder[header]}" – gir angriper innsikt i teknologistakk`,
      START_URL
    );
  }
}

// ── Test 3: HTTPS-håndhevelse ─────────────────────────────────────────────────

console.log('🔒 Sjekker HTTPS-håndhevelse...');
const httpUrl = START_URL.replace('https://', 'http://');
if (httpUrl !== START_URL) {
  const { status: httpStatus, hoder: httpHoder } = await hentHoder(httpUrl);
  if (httpStatus === 0) {
    leggTilFunn('https', 'ok', 'HTTP-tilkobling avvist', 'Serveren svarer ikke på HTTP', httpUrl);
  } else if ([301, 302, 307, 308].includes(httpStatus)) {
    const loc = httpHoder['location'] || '';
    if (loc.startsWith('https://')) {
      leggTilFunn('https', 'ok', 'HTTP omdirigerer til HTTPS', `Redirect: ${loc}`, httpUrl);
    } else {
      leggTilFunn('https', 'alvorlig', 'HTTP omdirigerer ikke til HTTPS', `Redirect går til: ${loc}`, httpUrl);
    }
  } else if (httpStatus >= 200 && httpStatus < 300) {
    leggTilFunn('https', 'kritisk', 'Siden er tilgjengelig over usikker HTTP', 'Innhold serveres over HTTP uten omdiriging til HTTPS', httpUrl);
  }
}

// ── Test 4: Sensitive stier ───────────────────────────────────────────────────

console.log('📂 Sjekker sensitive stier...');
for (const { sti, beskrivelse } of SENSITIVE_STIER) {
  const url = baseOrigin + sti;
  const { status, innhold } = await hentInnhold(url);
  if (status >= 200 && status < 300) {
    const harInnhold = innhold.trim().length > 10;
    leggTilFunn('sensitive-stier',
      sti.startsWith('/.env') || sti.includes('.git') ? 'kritisk' : 'alvorlig',
      `Sensitiv sti tilgjengelig: ${sti}`,
      `${beskrivelse} – HTTP ${status}${harInnhold ? `, ${innhold.length} tegn innhold` : ''}`,
      url
    );
  } else if (status === 403) {
    leggTilFunn('sensitive-stier', 'middels',
      `Sti gir 403 Forbidden: ${sti}`,
      `${beskrivelse} – eksisterer men er sperret`,
      url
    );
  }
  // 404 = OK, ikke rapport
}

// ── Test 5: Cookies ───────────────────────────────────────────────────────────

console.log('🍪 Sjekker cookie-sikkerhet...');
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

try {
  await page.goto(START_URL, { waitUntil: 'networkidle', timeout: 20000 });
} catch (e) {
  console.log(`  ⚠️ Kunne ikke laste siden: ${e.message}`);
}

const cookies = await context.cookies();
for (const cookie of cookies) {
  const problemer = [];
  if (!cookie.secure)   problemer.push('mangler Secure-flagg');
  if (!cookie.httpOnly) problemer.push('mangler HttpOnly-flagg');
  if (!cookie.sameSite || cookie.sameSite === 'None') problemer.push('SameSite er None eller ikke satt');

  if (problemer.length > 0) {
    leggTilFunn('cookies',
      !cookie.secure ? 'alvorlig' : 'middels',
      `Cookie "${cookie.name}" har svake sikkerhetsattributter`,
      problemer.join(', '),
      START_URL
    );
  } else {
    leggTilFunn('cookies', 'ok', `Cookie "${cookie.name}" har korrekte sikkerhetsattributter`, 'Secure + HttpOnly + SameSite er satt', START_URL);
  }
}

if (cookies.length === 0) {
  console.log('  ℹ️  Ingen cookies funnet (kan kreve innlogging)');
}

// ── Test 6: Mixed content ─────────────────────────────────────────────────────

console.log('🔀 Sjekker mixed content...');
const mixedContent = [];
page.on('request', req => {
  if (START_URL.startsWith('https://') && req.url().startsWith('http://')) {
    mixedContent.push(req.url());
  }
});

try {
  await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
} catch { /* ignorer */ }

if (mixedContent.length > 0) {
  for (const url of mixedContent) {
    leggTilFunn('mixed-content', 'alvorlig',
      'Mixed content – HTTP-ressurs på HTTPS-side',
      `Usikker ressurs lastes inn: ${url}`,
      page.url()
    );
  }
} else {
  leggTilFunn('mixed-content', 'ok', 'Ingen mixed content funnet', 'Alle ressurser lastes over HTTPS', START_URL);
}

// ── Test 7: Input-refleksjon (XSS) ────────────────────────────────────────────

console.log('💉 Sjekker input-refleksjon...');
const søkefelt = await page.$('input[type=search], input[name*=søk], input[name*=search], input[placeholder*=øk]');
if (søkefelt) {
  try {
    await søkefelt.fill(XSS_SØKEFELT_PAYLOAD);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    const sideTekst = await page.content();
    const reflektert = sideTekst.includes(XSS_SØKEFELT_PAYLOAD);
    const xssTriggert = await page.evaluate(() => window.__xsstest === 1).catch(() => false);

    if (xssTriggert) {
      const skjerm = await taSkjermdump(page, 'xss-kritisk');
      leggTilFunn('xss', 'kritisk',
        'XSS-payload kjørte i nettleseren',
        'Skript fra søkefeltet ble utført – kritisk sårbarhet',
        page.url(), { skjermdump: skjerm }
      );
    } else if (reflektert) {
      const skjerm = await taSkjermdump(page, 'xss-reflektert');
      leggTilFunn('xss', 'alvorlig',
        'Input reflekteres urensket i HTML',
        'Søkepayload finnes uendret i HTML – potensiell XSS',
        page.url(), { skjermdump: skjerm }
      );
    } else {
      leggTilFunn('xss', 'ok', 'Søkefelt ser ut til å rense input', 'Payload ble ikke reflektert urensket', page.url());
    }
  } catch (e) {
    console.log(`  ⚠️ Kunne ikke teste XSS: ${e.message}`);
  }
} else {
  console.log('  ℹ️  Ingen søkefelt funnet for XSS-test');
}

// ── Test 8: CORS ──────────────────────────────────────────────────────────────

console.log('🌐 Sjekker CORS-konfigurasjon...');
const corsRes = await new Promise(resolve => {
  const modul = START_URL.startsWith('https') ? https : http;
  const req = modul.request(START_URL, {
    method: 'OPTIONS', timeout: 8000,
    headers: {
      'Origin': 'https://ondomain.eksempel.no',
      'Access-Control-Request-Method': 'GET',
      'User-Agent': 'Mozilla/5.0 SikkerhetsTester/1.0',
    },
    rejectUnauthorized: false,
  }, res => resolve(res.headers));
  req.on('error', () => resolve({}));
  req.on('timeout', () => { req.destroy(); resolve({}); });
  req.end();
});

const corsOrigin = corsRes['access-control-allow-origin'];
if (corsOrigin === '*') {
  leggTilFunn('cors', 'alvorlig',
    'CORS tillater alle opphav (wildcard *)',
    'Access-Control-Allow-Origin: * – alle domener kan gjøre cross-origin-forespørsler',
    START_URL
  );
} else if (corsOrigin) {
  leggTilFunn('cors', 'ok', `CORS er begrenset til spesifikt opphav`, `Tillatt: ${corsOrigin}`, START_URL);
} else {
  leggTilFunn('cors', 'ok', 'Ingen CORS-hoder – standard same-origin-policy gjelder', '', START_URL);
}

await browser.close();

const varighet = Math.round((Date.now() - startTid) / 1000);

// ── Oppsummering ──────────────────────────────────────────────────────────────

const per_kategori = {};
for (const f of funn) {
  if (!per_kategori[f.kategori]) per_kategori[f.kategori] = [];
  per_kategori[f.kategori].push(f);
}

const kritiske  = funn.filter(f => f.alvorlighet === 'kritisk').length;
const alvorlige = funn.filter(f => f.alvorlighet === 'alvorlig').length;
const middels   = funn.filter(f => f.alvorlighet === 'middels').length;
const lave      = funn.filter(f => f.alvorlighet === 'lav').length;
const ok        = funn.filter(f => f.alvorlighet === 'ok').length;

const score = Math.max(0, 100 - kritiske * 20 - alvorlige * 10 - middels * 5 - lave * 2);
const scoreKlasse = score >= 80 ? 'god' : score >= 50 ? 'middels' : 'dårlig';

console.log(`\n${'━'.repeat(60)}`);
console.log(`🔐 SIKKERHETSRAPPORT – ${START_URL}`);
console.log('━'.repeat(60));
console.log(`🔴 Kritiske:   ${kritiske}`);
console.log(`🟠 Alvorlige:  ${alvorlige}`);
console.log(`🟡 Moderate:   ${middels}`);
console.log(`🔵 Lave:       ${lave}`);
console.log(`✅ Bestått:    ${ok}`);
console.log(`📊 Score:      ${score}/100`);
console.log(`⏱️  Varighet:   ${varighet}s`);
console.log('━'.repeat(60));

// Lagre JSON
fs.writeFileSync(
  path.join(rapportDir, 'sikkerhet-resultat.json'),
  JSON.stringify({ url: START_URL, dato, score, totalt: { kritiske, alvorlige, middels, lave, ok, varighet }, funn }, null, 2)
);

// ── HTML-rapport ──────────────────────────────────────────────────────────────

const KATEGORIER = {
  'hoder':               { tittel: 'HTTP-sikkerhetshoder',       ikon: '📋' },
  'informasjonslekkasje':{ tittel: 'Informasjonslekkasje',       ikon: '🕵️' },
  'https':               { tittel: 'HTTPS-håndhevelse',          ikon: '🔒' },
  'sensitive-stier':     { tittel: 'Sensitive stier og filer',   ikon: '📂' },
  'cookies':             { tittel: 'Cookie-sikkerhet',           ikon: '🍪' },
  'mixed-content':       { tittel: 'Mixed content',              ikon: '🔀' },
  'xss':                 { tittel: 'Input-refleksjon (XSS)',      ikon: '💉' },
  'cors':                { tittel: 'CORS-konfigurasjon',         ikon: '🌐' },
};

function alvorlighetFarge(a) {
  return { kritisk: '#c53030', alvorlig: '#9a3412', middels: '#b8860b', lav: '#4b5563', ok: '#07604f' }[a] || '#4b5563';
}

const sidenavigasjon = Object.entries(KATEGORIER).map(([id, { tittel, ikon }]) => {
  const kfunn = (per_kategori[id] || []).filter(f => f.alvorlighet !== 'ok');
  const klasse = kfunn.some(f => f.alvorlighet === 'kritisk') ? 'har-kritiske'
    : kfunn.some(f => ['alvorlig','middels'].includes(f.alvorlighet)) ? 'har-brudd'
    : 'ok';
  return `<li><a href="#${id}" class="sidenav-link ${klasse}">
    <span class="sidenavn">${ikon} ${tittel}</span>
    <span class="side-badge">${kfunn.length > 0 ? kfunn.length + ' funn' : '✅ Bestått'}</span>
  </a></li>`;
}).join('');

function funnKort(f) {
  if (f.alvorlighet === 'ok') return '';
  return `
  <div class="brudd-kort" style="border-left-color:${alvorlighetFarge(f.alvorlighet)}">
    <div class="brudd-header">
      <div>
        <span class="badge ${f.alvorlighet}">${f.alvorlighet}</span>
        <span class="regel-desc">${f.tittel}</span>
      </div>
    </div>
    ${f.detalj ? `<p class="brudd-hjelp">${f.detalj}</p>` : ''}
    ${f.url && f.url !== START_URL ? `<div class="node-info"><span class="node-selector">${f.url}</span></div>` : ''}
    ${f.skjermdump ? `
    <div class="skjermdump-gruppe">
      <div class="skjermdump-wrapper">
        <p class="skjermdump-label">Skjermdump</p>
        <a href="${f.skjermdump}" target="_blank">
          <img src="${f.skjermdump}" alt="Skjermdump" class="skjermdump helside" loading="lazy">
        </a>
      </div>
    </div>` : ''}
  </div>`;
}

function okListe(kfunn) {
  const bestått = kfunn.filter(f => f.alvorlighet === 'ok');
  if (bestått.length === 0) return '';
  return `<details style="margin-top:.8rem"><summary style="font-size:.78rem;color:#07604f;cursor:pointer;padding:.4rem 0">✅ ${bestått.length} sjekk bestått</summary>
    <ul style="list-style:none;margin-top:.5rem;display:flex;flex-direction:column;gap:.3rem">
      ${bestått.map(f => `<li style="font-size:.78rem;color:#374151;padding:.3rem .6rem;background:#ecfdf5;border-left:3px solid #07604f">✅ ${f.tittel}${f.detalj ? ` — <span style="color:#6b7280">${f.detalj}</span>` : ''}</li>`).join('')}
    </ul>
  </details>`;
}

const seksjoner = Object.entries(KATEGORIER).map(([id, { tittel, ikon }]) => {
  const kfunn = per_kategori[id] || [];
  const problemer = kfunn.filter(f => f.alvorlighet !== 'ok');
  return `
  <div class="seksjon" id="${id}">
    <div class="seksjon-tittel">${ikon} ${tittel} (${problemer.length} funn)</div>
    ${problemer.length === 0
      ? '<div class="wcag-ok">Ingen funn i denne kategorien</div>'
      : problemer.map(funnKort).join('')}
    ${okListe(kfunn)}
  </div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sikkerhetsrapport – ${dato} ${tidspunkt}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#faf6f0;color:#0f0e17;display:flex;min-height:100vh}
  .sidemeny{width:272px;min-width:272px;background:#0a1355;color:white;padding:0;overflow-y:auto;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
  .sidemeny-header{padding:1.2rem 1.4rem;border-bottom:1px solid rgba(255,255,255,.1)}
  .sidemeny-logo{font-size:.7rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;opacity:.45;margin-bottom:.5rem}
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
  .knapp{display:inline-block;padding:.5rem 1.2rem;background:#0a1355;color:white;border-radius:100px;font-size:.82rem;font-weight:500;text-decoration:none;white-space:nowrap;transition:background .15s}
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
  .badge.kritisk{background:#fee2e2;color:#c53030}
  .badge.alvorlig{background:#fde8d4;color:#9a3412}
  .badge.middels{background:#f3dda2;color:#713f12}
  .badge.lav{background:#f1f0ee;color:#4b5563}
  .wcag-ok{background:#ecfdf5;color:#064e3b;padding:.8rem 1rem;border-left:3px solid #07604f;font-size:.88rem}
  footer{text-align:center;padding:2.5rem;color:#9ca3af;font-size:.78rem;border-top:1px solid #f1f0ee;margin-top:2rem}
</style>
</head>
<body>
<nav class="sidemeny">
  <div class="sidemeny-header">
    <div class="sidemeny-logo">KS Tilskudd · Sikkerhetstester</div>
    <h1>Sikkerhetsrapport <span>${dato} ${tidspunkt}</span></h1>
  </div>
  <ul>${sidenavigasjon}</ul>
</nav>
<div class="hoveddel">
  <div class="rapport-header">
    <div>
      <h1>Sikkerhetsrapport</h1>
      <div class="meta"><a href="${START_URL}" target="_blank">${START_URL}</a> · ${dato} ${tidspunkt} · ${varighet}s</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp sekundær">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp aktiv">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
    </div>
  </div>

  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er sikkerhetstesting?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      Sikkerhetstesten kjører passive, ikke-destruktive kontroller mot applikasjonen for å avdekke
      vanlige konfigurasjonssvakheter og sårbarheter. Ingen data endres og ingen angrep gjennomføres.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva testes</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>📋 HTTP-sikkerhetshoder (8 stk.)</li>
          <li>🔒 HTTPS-håndhevelse og HSTS</li>
          <li>🍪 Cookie-sikkerhetsattributter</li>
          <li>📂 Sensitive stier og filer</li>
          <li>💉 Input-refleksjon (XSS)</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva måles</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Manglende sikkerhetshoder</li>
          <li>Informasjonslekkasje i svar</li>
          <li>Mixed content (HTTP på HTTPS)</li>
          <li>CORS-feilkonfigurasjon</li>
          <li>Tilgjengelige sensitive stier</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Metode og begrensning</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Passiv analyse – ingen destruktive tester</li>
          <li>Kjøres fra lokalt nettverk</li>
          <li>Playwright + HTTP-forespørsler</li>
          <li>Krever ikke innlogging</li>
          <li>Daglig kjøring kl. 08:30</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="score-kort">
    <div class="score-sirkel ${scoreKlasse}">${score}</div>
    <div class="score-tekst">
      <strong>Sikkerhetsscore</strong>
      <p>Basert på ${kritiske + alvorlige + middels + lave} funn fordelt på ${Object.keys(KATEGORIER).length} testområder. Testen er passiv og ikke-destruktiv.</p>
    </div>
  </div>

  <div class="kort-grid">
    <div class="kort ${kritiske > 0 ? 'kritisk' : 'ok'}"><div class="tall">${kritiske}</div><div class="etikett">Kritiske</div></div>
    <div class="kort ${alvorlige > 0 ? 'advarsel' : 'ok'}"><div class="tall">${alvorlige}</div><div class="etikett">Alvorlige</div></div>
    <div class="kort ${middels > 0 ? 'advarsel' : 'ok'}"><div class="tall">${middels}</div><div class="etikett">Moderate</div></div>
    <div class="kort ${lave > 0 ? 'nøytral' : 'ok'}"><div class="tall">${lave}</div><div class="etikett">Lave</div></div>
    <div class="kort ok"><div class="tall">${ok}</div><div class="etikett">Bestått</div></div>
  </div>

  ${seksjoner}

  <div class="seksjon" style="margin-top:2rem">
    <div class="seksjon-tittel">Slik beregnes sikkerhetsscoren</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">Kritisk funn</span><span style="color:#c53030;font-weight:700">× 20 poeng</span>
      <span style="color:#374151">Alvorlig funn</span><span style="color:#9a3412;font-weight:700">× 10 poeng</span>
      <span style="color:#374151">Moderat funn</span><span style="color:#713f12;font-weight:700">× 5 poeng</span>
      <span style="color:#374151">Lavt funn</span><span style="color:#6b7280;font-weight:700">× 2 poeng</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Score = maks(0, 100 − sum av trekk) &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>
  <footer>KS Tilskudd · Sikkerhetstester · Playwright · ${dato} ${tidspunkt}</footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(rapportDir, 'sikkerhet-rapport.html'), html);

// Lagre tidsstemplet kopi for arkiv (bevarer alle kjøringer samme dag)
const tidFil = tidspunkt.replace(':', '-');
fs.copyFileSync(path.join(rapportDir, 'sikkerhet-resultat.json'), path.join(rapportDir, `sikkerhet-resultat-${tidFil}.json`));
fs.copyFileSync(path.join(rapportDir, 'sikkerhet-rapport.html'), path.join(rapportDir, `sikkerhet-rapport-${tidFil}.html`));

console.log(`\n📁 Sikkerhetsrapport: ${path.join(rapportDir, 'sikkerhet-rapport.html')}`);
exec(`open "${path.join(rapportDir, 'sikkerhet-rapport.html')}"`);
