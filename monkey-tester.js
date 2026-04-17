import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_URL = process.argv[2] || 'https://tilskudd.fiks.ks.no/';
const ITERASJONER = parseInt(process.argv[3]) || 60;
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = path.join(__dirname, 'rapporter', dato);
const skjermDir = path.join(rapportDir, 'skjermbilder-monkey');
fs.mkdirSync(skjermDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;

console.log(`\n🐒 Starter monkey-testing av: ${START_URL}`);
console.log(`📅 Dato: ${dato}`);
console.log(`🔄 Iterasjoner: ${ITERASJONER}\n`);

// ── Tilfeldig testdata ──────────────────────────────────────────────────────
const tilfeldigTekst = () => {
  const typer = [
    () => '',
    () => 'Test bruker',
    () => 'æøå ÆØÅ',
    () => '   ',
    () => '0',
    () => '-1',
    () => '9'.repeat(20),
    () => '!@#$%&*()',
    () => 'null undefined NaN',
    () => 'a'.repeat(500),
    () => '<b>bold</b>',
    () => Array.from({ length: 8 }, () => Math.random().toString(36).slice(2)).join(' '),
  ];
  return typer[Math.floor(Math.random() * typer.length)]();
};

const tilfeldigEpost = () => {
  const u = ['bruker', 'test', 'ugyldig', '', 'æøå', 'admin'];
  return `${u[Math.floor(Math.random() * u.length)]}@eksempel.no`;
};

// ── Resultatlagring ─────────────────────────────────────────────────────────
const jsErrors     = [];
const konsollFeil  = [];
const nettverksFeil = [];
const interaksjoner = [];
const besøkte      = new Set();
let skjermTeller   = 0;
let startTid       = Date.now();

// ── Browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 MonkeyTester/1.0',
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

page.on('pageerror', err => {
  jsErrors.push({ melding: err.message, stack: err.stack, url: page.url(), tid: nowStr() });
  console.log(`  ⚡ JS-feil: ${err.message.slice(0, 80)}`);
});

page.on('console', msg => {
  if (msg.type() === 'error') {
    konsollFeil.push({ melding: msg.text(), url: page.url(), tid: nowStr() });
  }
});

page.on('response', resp => {
  const s = resp.status();
  if (s >= 400 && !resp.url().includes('favicon') && !resp.url().includes('analytics')) {
    nettverksFeil.push({ status: s, url: resp.url(), side: page.url(), tid: nowStr() });
    console.log(`  🌐 HTTP ${s}: ${resp.url().slice(0, 80)}`);
  }
});

function nowStr() { return new Date().toISOString(); }

async function taSkjermdump(prefix) {
  skjermTeller++;
  const filnavn = `monkey-${prefix}-${skjermTeller}.png`;
  try {
    await page.screenshot({ path: path.join(skjermDir, filnavn), fullPage: false });
    return `skjermbilder-monkey/${filnavn}`;
  } catch { return null; }
}

async function resetTilStart() {
  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 12000 });
  } catch { /* ignorer */ }
}

async function sjekkForFeilside() {
  try {
    const tekst = await page.textContent('body');
    const feilord = ['500', 'Internal Server Error', 'Something went wrong',
                     'Uventet feil', 'Oops', 'Ops!', '404 – Siden'];
    for (const ord of feilord) {
      if (tekst.includes(ord)) return ord;
    }
  } catch { /* ignorer */ }
  return null;
}

// ── Start navigasjon ─────────────────────────────────────────────────────────
try {
  await page.goto(START_URL, { waitUntil: 'networkidle', timeout: 20000 });
} catch (e) {
  console.log(`❌ Kunne ikke laste startsiden: ${e.message}`);
  await browser.close();
  process.exit(1);
}

// ── Monkey-løkke ─────────────────────────────────────────────────────────────
for (let i = 0; i < ITERASJONER; i++) {
  const currentUrl = page.url();
  besøkte.add(currentUrl);
  const handling = Math.random();
  let type = '';
  let detalj = '';
  let skjerm = null;
  let ok = true;

  // Naviger bort fra eksterne sider
  if (!currentUrl.startsWith(baseOrigin)) {
    await resetTilStart();
    continue;
  }

  try {
    if (handling < 0.35) {
      // Klikk tilfeldig knapp / lenke
      type = 'klikk';
      const elementer = await page.$$('button:visible, [role="button"]:visible');
      if (elementer.length > 0) {
        const el = elementer[Math.floor(Math.random() * elementer.length)];
        const tekst = (await el.textContent().catch(() => '')).trim().slice(0, 60);
        detalj = `Klikket: "${tekst || '(ingen tekst)'}"`;
        console.log(`  🖱️  [${i+1}] ${detalj}`);
        await el.click({ timeout: 4000, force: false }).catch(() => {});
        await page.waitForTimeout(800);
      } else {
        // Prøv lenker
        const lenker = await page.$$('a[href]:visible');
        const interne = [];
        for (const l of lenker) {
          const href = await l.getAttribute('href').catch(() => '');
          if (href && (href.startsWith('/') || href.startsWith(baseOrigin))) interne.push(l);
        }
        if (interne.length > 0) {
          const el = interne[Math.floor(Math.random() * interne.length)];
          const tekst = (await el.textContent().catch(() => '')).trim().slice(0, 60);
          detalj = `Klikket lenke: "${tekst}"`;
          console.log(`  🔗 [${i+1}] ${detalj}`);
          await el.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(800);
        }
      }

    } else if (handling < 0.55) {
      // Fyll inn tilfeldig tekst i skjemafelt
      type = 'skjemafyll';
      const inputs = await page.$$('input:visible:not([type=hidden]):not([type=submit]):not([type=button]), textarea:visible');
      if (inputs.length > 0) {
        const inp = inputs[Math.floor(Math.random() * inputs.length)];
        const inputType = await inp.getAttribute('type').catch(() => 'text') || 'text';
        let verdi = inputType === 'email' ? tilfeldigEpost() : tilfeldigTekst();
        detalj = `Fylte "${verdi.slice(0, 40)}" i ${inputType}-felt`;
        console.log(`  ✏️  [${i+1}] ${detalj}`);
        await inp.fill(verdi, { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
      }

    } else if (handling < 0.70) {
      // Send inn skjema
      type = 'skjemasubmit';
      const knapper = await page.$$('button[type=submit]:visible, input[type=submit]:visible');
      if (knapper.length > 0) {
        const btn = knapper[Math.floor(Math.random() * knapper.length)];
        const tekst = (await btn.textContent().catch(() => '')).trim().slice(0, 40);
        detalj = `Send skjema: "${tekst}"`;
        console.log(`  📤 [${i+1}] ${detalj}`);
        skjerm = await taSkjermdump('pre-submit');
        await btn.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }

    } else if (handling < 0.82) {
      // Tilbake-navigasjon
      type = 'navigasjon';
      detalj = 'Gikk tilbake (browser back)';
      console.log(`  ⬅️  [${i+1}] ${detalj}`);
      await page.goBack({ timeout: 6000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(500);

    } else {
      // Reset til start
      type = 'reset';
      detalj = 'Reset til startside';
      console.log(`  🏠 [${i+1}] ${detalj}`);
      await resetTilStart();
    }

    // Sjekk for feilside etter interaksjon
    const feilord = await sjekkForFeilside();
    if (feilord) {
      skjerm = await taSkjermdump('feilside');
      interaksjoner.push({
        type: 'feilside', alvorlighet: 'kritisk',
        melding: `Feilside etter ${type}: inneholder "${feilord}"`,
        url: page.url(), handling: detalj, skjermdump: skjerm, tid: nowStr()
      });
      ok = false;
      await resetTilStart();
    }

  } catch (e) {
    type = type || 'ukjent';
    detalj = detalj || '—';
    skjerm = await taSkjermdump('unntak');
    interaksjoner.push({
      type: 'unntak', alvorlighet: 'alvorlig',
      melding: e.message.slice(0, 200),
      url: page.url(), handling: detalj, skjermdump: skjerm, tid: nowStr()
    });
    ok = false;
    await resetTilStart();
  }
}

await browser.close();

const varighet = Math.round((Date.now() - startTid) / 1000);

// ── Sammendrag ───────────────────────────────────────────────────────────────
const totalt = {
  iterasjoner: ITERASJONER,
  siderBesøkt: besøkte.size,
  jsErrors: jsErrors.length,
  konsollFeil: konsollFeil.length,
  nettverksFeil: nettverksFeil.length,
  kritiske: interaksjoner.filter(f => f.alvorlighet === 'kritisk').length,
  alvorlige: interaksjoner.filter(f => f.alvorlighet === 'alvorlig').length,
  varighet,
};

const score = Math.max(0, 100
  - totalt.kritiske * 20
  - totalt.alvorlige * 10
  - totalt.jsErrors * 8
  - totalt.konsollFeil * 3
  - totalt.nettverksFeil * 5
);

console.log(`\n${'━'.repeat(60)}`);
console.log(`🐒 MONKEY-RAPPORT – ${START_URL}`);
console.log('━'.repeat(60));
console.log(`🔄 Iterasjoner:      ${ITERASJONER}`);
console.log(`📄 Sider besøkt:     ${totalt.siderBesøkt}`);
console.log(`⚡ JS-feil:          ${jsErrors.length}`);
console.log(`🖥️  Konsoll-feil:     ${konsollFeil.length}`);
console.log(`🌐 Nettverksfeil:    ${nettverksFeil.length}`);
console.log(`💥 Kritiske funn:    ${totalt.kritiske}`);
console.log(`⏱️  Varighet:         ${varighet}s`);
console.log('━'.repeat(60));

// Lagre JSON-resultater
fs.writeFileSync(
  path.join(rapportDir, 'monkey-resultat.json'),
  JSON.stringify({ url: START_URL, dato, totalt, score, jsErrors, konsollFeil, nettverksFeil, interaksjoner, besøkte: [...besøkte] }, null, 2)
);

// ── HTML-rapport ─────────────────────────────────────────────────────────────
function alvorlighetFarge(a) {
  return { kritisk: '#c53030', alvorlig: '#9a3412', middels: '#b8860b', lav: '#4b5563' }[a] || '#4b5563';
}

const scoreKlasse = score >= 80 ? 'god' : score >= 50 ? 'middels' : 'dårlig';

function seksjonNav(id, label, antall, klasse) {
  return `<li><a href="#${id}" class="sidenav-link ${klasse}">
    <span class="sidenavn">${label}</span>
    <span class="side-badge">${antall} funn</span>
  </a></li>`;
}

const sidenavigasjon = [
  seksjonNav('sammendrag', 'Sammendrag', '', ''),
  seksjonNav('js-feil', 'JS-feil', jsErrors.length, jsErrors.length > 0 ? 'har-kritiske' : 'ok'),
  seksjonNav('konsoll', 'Konsoll-feil', konsollFeil.length, konsollFeil.length > 0 ? 'har-brudd' : 'ok'),
  seksjonNav('nettverk', 'Nettverksfeil', nettverksFeil.length, nettverksFeil.length > 0 ? 'har-brudd' : 'ok'),
  seksjonNav('interaksjoner', 'Interaksjonsfunn', interaksjoner.length, interaksjoner.length > 0 ? 'har-kritiske' : 'ok'),
  seksjonNav('sider', 'Sider besøkt', besøkte.size, ''),
].join('');

function funnRad(f, i) {
  return `
  <div class="brudd-kort" style="border-left-color:${alvorlighetFarge(f.alvorlighet)}">
    <div class="brudd-header">
      <div>
        <span class="badge ${f.alvorlighet}">${f.alvorlighet}</span>
        <span class="regel-desc">${f.melding}</span>
      </div>
      <span class="brudd-teller">${f.tid?.slice(11, 19) || ''}</span>
    </div>
    ${f.handling ? `<p class="brudd-hjelp">Handling: ${f.handling}</p>` : ''}
    <div class="node-info"><span class="node-selector">${f.url}</span></div>
    ${f.skjermdump ? `
    <div class="skjermdump-gruppe">
      <div class="skjermdump-wrapper">
        <p class="skjermdump-label">Skjermdump ved funn</p>
        <a href="${f.skjermdump}" target="_blank">
          <img src="${f.skjermdump}" alt="Skjermdump" class="skjermdump helside" loading="lazy">
        </a>
      </div>
    </div>` : ''}
  </div>`;
}

function feilTabell(liste, kolonner) {
  if (liste.length === 0) return '<div class="wcag-ok">Ingen funn</div>';
  return `<table><thead><tr>${kolonner.map(k => `<th>${k}</th>`).join('')}</tr></thead><tbody>
    ${liste.map(r => `<tr>${kolonner.map(k => `<td style="font-size:.8rem;word-break:break-all">${r[k.toLowerCase().replace(/ /g,'_')] ?? r[Object.keys(r)[kolonner.indexOf(k)]] ?? ''}</td>`).join('')}</tr>`).join('')}
  </tbody></table>`;
}

const html = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monkey-testrapport – ${dato} ${tidspunkt}</title>
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
  .rapport-header .meta a:hover{text-decoration:underline}
  .nav-knapper{display:flex;gap:.6rem;flex-wrap:wrap}
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
  .kort-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:.8rem;margin-bottom:2rem}
  .kort{background:white;padding:1.2rem 1rem;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .kort.kritisk{border-left-color:#c53030}.kort.advarsel{border-left-color:#b8860b}.kort.ok{border-left-color:#07604f}
  .kort .tall{font-size:2rem;font-weight:700;margin:.3rem 0;color:#0a1355}
  .kort .etikett{font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .kort .undertekst{font-size:.7rem;color:#9ca3af;margin-top:.25rem}
  .seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .seksjon-tittel{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid #f4ecdf}
  .brudd-kort{background:#faf6f0;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;padding:1rem 1.1rem;margin-bottom:.7rem}
  .brudd-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.5rem;gap:.5rem;flex-wrap:wrap}
  .regel-desc{font-size:.84rem;color:#374151}
  .brudd-teller{font-size:.72rem;color:#9ca3af;white-space:nowrap;flex-shrink:0}
  .brudd-hjelp{font-size:.82rem;color:#555;margin:.6rem 0;padding:.5rem .8rem;background:#f4ecdf;border-left:3px solid #b8860b}
  .node-info{background:#f1f0ee;padding:.5rem .7rem;margin:.4rem 0;font-size:.8rem}
  .node-selector{display:block;color:#2b3285;font-family:ui-monospace,monospace;word-break:break-all;font-size:.78rem}
  .skjermdump-gruppe{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:.9rem}
  .skjermdump-wrapper{background:#f1f0ee;padding:.7rem}
  .skjermdump-label{font-size:.68rem;color:#6b7280;margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}
  .skjermdump{width:100%;border:1px solid #e5e3de;cursor:zoom-in;transition:box-shadow .2s;display:block}
  .skjermdump:hover{box-shadow:0 4px 16px rgba(10,19,85,.15)}
  .helside{max-height:300px;object-fit:cover;object-position:top}
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{background:#f4ecdf;text-align:left;padding:.5rem .7rem;font-weight:600;color:#0a1355;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.45rem .7rem;border-bottom:1px solid #f1f0ee;vertical-align:top}
  .badge{display:inline-block;padding:.15rem .6rem;border-radius:100px;font-size:.7rem;font-weight:600;margin-right:.3rem}
  .badge.kritisk{background:#fee2e2;color:#c53030}
  .badge.alvorlig{background:#fde8d4;color:#9a3412}
  .badge.feilside{background:#fee2e2;color:#c53030}
  .badge.unntak{background:#fde8d4;color:#9a3412}
  .wcag-ok{background:#ecfdf5;color:#064e3b;padding:.8rem 1rem;border-left:3px solid #07604f;font-size:.88rem}
  .url-liste{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:.3rem}
  .url-liste li{font-size:.78rem;background:#f4ecdf;padding:.35rem .7rem;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  footer{text-align:center;padding:2.5rem;color:#9ca3af;font-size:.78rem;border-top:1px solid #f1f0ee;margin-top:2rem}
</style>
</head>
<body>
<nav class="sidemeny">
  <div class="sidemeny-header">
    <div class="sidemeny-logo">KS Tilskudd · Monkey-tester</div>
    <h1>Monkey-testrapport <span>${dato} ${tidspunkt} · ${ITERASJONER} iterasjoner</span></h1>
  </div>
  <ul>${sidenavigasjon}</ul>
</nav>
<div class="hoveddel">
  <div class="rapport-header">
    <div>
      <h1>Monkey-testrapport</h1>
      <div class="meta"><a href="${START_URL}" target="_blank">${START_URL}</a> · ${dato} ${tidspunkt} · ${varighet}s · ${ITERASJONER} tilfeldige handlinger</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp sekundær">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp aktiv">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
    </div>
  </div>

  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er monkey-testing?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      Monkey-testing simulerer en uforutsigbar bruker som klikker og skriver tilfeldig i applikasjonen –
      uten å følge en bestemt flyt. Formålet er å avdekke krasj, ubehandlede feil og uventet oppførsel
      som ikke fanges opp av ordinære tester.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva testes</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>🖱️ Tilfeldige knappeklikk</li>
          <li>✏️ Ugyldig og tom skjemainput</li>
          <li>📤 Skjemaer sendt ut av kontekst</li>
          <li>⬅️ Uventet tilbake-navigasjon</li>
          <li>🔗 Tilfeldige lenker innad på siden</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva måles</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>⚡ Ubehandlede JavaScript-feil</li>
          <li>🖥️ console.error()-kall</li>
          <li>🌐 HTTP 4xx/5xx-svar fra API</li>
          <li>💥 Feilsider og krasj</li>
          <li>📄 Antall sider applikasjonen når</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Testdata brukt</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Tom streng og mellomrom</li>
          <li>Spesialtegn (!@#$%&amp;)</li>
          <li>Norske tegn (æøå ÆØÅ)</li>
          <li>Veldig lang tekst (500 tegn)</li>
          <li>Ugyldig e-postadresse</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="score-kort">
    <div class="score-sirkel ${scoreKlasse}">${score}</div>
    <div class="score-tekst">
      <strong>Robusthetsscore</strong>
      <p>Basert på JS-feil, nettverksfeil og kritiske funn etter ${ITERASJONER} tilfeldige interaksjoner på ${besøkte.size} sider. Lavere score indikerer ustabilitet.</p>
    </div>
  </div>

  <div class="kort-grid">
    <div class="kort ok"><div class="tall">${ITERASJONER}</div><div class="etikett">Iterasjoner</div></div>
    <div class="kort ok"><div class="tall">${besøkte.size}</div><div class="etikett">Sider besøkt</div></div>
    <div class="kort ${jsErrors.length > 0 ? 'kritisk' : 'ok'}"><div class="tall">${jsErrors.length}</div><div class="etikett">JS-feil</div></div>
    <div class="kort ${konsollFeil.length > 0 ? 'advarsel' : 'ok'}"><div class="tall">${konsollFeil.length}</div><div class="etikett">Konsoll-feil</div></div>
    <div class="kort ${nettverksFeil.length > 0 ? 'advarsel' : 'ok'}"><div class="tall">${nettverksFeil.length}</div><div class="etikett">Nettverksfeil</div></div>
    <div class="kort ${totalt.kritiske > 0 ? 'kritisk' : 'ok'}"><div class="tall">${totalt.kritiske}</div><div class="etikett">Kritiske funn</div></div>
  </div>

  <!-- JS-feil -->
  <div class="seksjon" id="js-feil">
    <div class="seksjon-tittel">JS-feil (${jsErrors.length})</div>
    ${jsErrors.length === 0
      ? '<div class="wcag-ok">Ingen ubehandlede JavaScript-feil oppdaget</div>'
      : jsErrors.map(e => `
        <div class="brudd-kort" style="border-left-color:#c53030">
          <div class="brudd-header">
            <span class="badge kritisk">JS-feil</span>
            <span class="brudd-teller">${e.tid.slice(11,19)}</span>
          </div>
          <p class="regel-desc">${e.melding}</p>
          <div class="node-info"><span class="node-selector">${e.url}</span></div>
          ${e.stack ? `<details style="margin-top:.6rem"><summary style="font-size:.75rem;color:#6b7280;cursor:pointer">Stack trace</summary><pre style="font-size:.72rem;background:#f1f0ee;padding:.6rem;overflow:auto;margin-top:.4rem;white-space:pre-wrap">${e.stack.slice(0,800)}</pre></details>` : ''}
        </div>`).join('')}
  </div>

  <!-- Konsoll-feil -->
  <div class="seksjon" id="konsoll">
    <div class="seksjon-tittel">Konsoll-feil (${konsollFeil.length})</div>
    ${konsollFeil.length === 0
      ? '<div class="wcag-ok">Ingen console.error()-kall oppdaget</div>'
      : `<table><thead><tr><th>Tidspunkt</th><th>Melding</th><th>URL</th></tr></thead><tbody>
          ${konsollFeil.map(f => `<tr>
            <td style="white-space:nowrap">${f.tid.slice(11,19)}</td>
            <td>${f.melding.slice(0,120)}</td>
            <td style="font-size:.75rem;word-break:break-all">${f.url}</td>
          </tr>`).join('')}
        </tbody></table>`}
  </div>

  <!-- Nettverksfeil -->
  <div class="seksjon" id="nettverk">
    <div class="seksjon-tittel">Nettverksfeil (${nettverksFeil.length})</div>
    ${nettverksFeil.length === 0
      ? '<div class="wcag-ok">Ingen HTTP 4xx/5xx-svar oppdaget</div>'
      : `<table><thead><tr><th>Status</th><th>URL</th><th>Fra side</th></tr></thead><tbody>
          ${nettverksFeil.map(f => `<tr>
            <td><span class="badge ${f.status >= 500 ? 'kritisk' : 'alvorlig'}">${f.status}</span></td>
            <td style="font-size:.75rem;word-break:break-all">${f.url.slice(0,100)}</td>
            <td style="font-size:.75rem;word-break:break-all">${f.side}</td>
          </tr>`).join('')}
        </tbody></table>`}
  </div>

  <!-- Interaksjonsfunn -->
  <div class="seksjon" id="interaksjoner">
    <div class="seksjon-tittel">Interaksjonsfunn (${interaksjoner.length})</div>
    ${interaksjoner.length === 0
      ? '<div class="wcag-ok">Ingen kritiske funn under monkey-testing</div>'
      : interaksjoner.map(funnRad).join('')}
  </div>

  <!-- Sider besøkt -->
  <div class="seksjon" id="sider">
    <div class="seksjon-tittel">Sider besøkt (${besøkte.size})</div>
    <ul class="url-liste">
      ${[...besøkte].sort().map(u => `<li title="${u}">${u}</li>`).join('')}
    </ul>
  </div>

  <div class="seksjon" style="margin-top:2rem">
    <div class="seksjon-tittel">Slik beregnes robusthetssscoren</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">Kritisk funn</span><span style="color:#c53030;font-weight:700">× 20 poeng</span>
      <span style="color:#374151">Alvorlig funn</span><span style="color:#9a3412;font-weight:700">× 10 poeng</span>
      <span style="color:#374151">JS-feil</span><span style="color:#9a3412;font-weight:700">× 8 poeng</span>
      <span style="color:#374151">Nettverksfeil</span><span style="color:#713f12;font-weight:700">× 5 poeng</span>
      <span style="color:#374151">Konsoll-feil</span><span style="color:#6b7280;font-weight:700">× 3 poeng</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Score = maks(0, 100 − sum av trekk) &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>
  <footer>KS Tilskudd · Monkey-tester · Playwright · ${dato} ${tidspunkt}</footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(rapportDir, 'monkey-rapport.html'), html);

// Lagre tidsstemplet kopi for arkiv (bevarer alle kjøringer samme dag)
const tidFil = tidspunkt.replace(':', '-');
fs.copyFileSync(path.join(rapportDir, 'monkey-resultat.json'), path.join(rapportDir, `monkey-resultat-${tidFil}.json`));
fs.copyFileSync(path.join(rapportDir, 'monkey-rapport.html'), path.join(rapportDir, `monkey-rapport-${tidFil}.html`));

console.log(`\n📁 Monkey-rapport: ${path.join(rapportDir, 'monkey-rapport.html')}`);

// Åpne rapporten
import { exec } from 'child_process';
exec(`open "${path.join(rapportDir, 'monkey-rapport.html')}"`);
