// generer-brukerhistorie-rapport.js (PROD)
// Les brukerhistorie-resultater/brukerhistorie-resultat.json og generer docs/brukerhistorie-rapport.html

import fs from 'fs';
import path from 'path';
import { START_URL } from './config.js';

const jsonPath = 'brukerhistorie-resultater/brukerhistorie-resultat.json';
const utPath   = 'docs/brukerhistorie-rapport.html';

const iDag = new Date().toISOString().slice(0, 10);
const datoDir = `rapporter/${iDag}`;
if (!fs.existsSync(datoDir)) fs.mkdirSync(datoDir, { recursive: true });
const datoUtPath = `${datoDir}/brukerhistorie-rapport.html`;

if (!fs.existsSync(jsonPath)) {
  console.error(`Finner ikke ${jsonPath} – kjør 'npm run brukerhistorie' først.`);
  process.exit(1);
}

const data   = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
const stats  = data.stats ?? {};

const metadataPath = 'brukerhistorie-metadata.json';
const jiraMetadata = fs.existsSync(metadataPath)
  ? JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
  : {};

const allBhSuites = (data.suites ?? []).flatMap(s => s.suites ?? []);
const bhMap = new Map();
for (const suite of allBhSuites) bhMap.set(suite.title, suite);

const suites = [...bhMap.values()];

const startTime = new Date(stats.startTime);
const dato = startTime.toISOString().slice(0, 10);
const tid  = startTime.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
const datotid = `${dato} ${tid}`;

const alleSpecs = suites.flatMap(s => s.specs ?? []);
const totaltBestatt = alleSpecs.filter(sp => sp.ok && !(sp.tests?.some(t => t.status === 'skipped'))).length;
const totaltFeilet  = alleSpecs.filter(sp => !sp.ok).length;
const totaltHoppet  = alleSpecs.filter(sp => sp.tests?.some(t => t.status === 'skipped')).length;
const totaltTester  = totaltBestatt + totaltFeilet + totaltHoppet;

const pct = totaltTester > 0 ? Math.round((totaltBestatt / totaltTester) * 100) : 0;
const scoreFarge = pct === 100 ? '#07604f' : pct >= 70 ? '#b8860b' : '#c53030';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lesSkjermbilder(id) {
  const dir = 'brukerhistorie-resultater/skjermbilder';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(`${id}-`) && f.endsWith('.png'))
    .sort()
    .map(f => ({
      filnavn: f,
      base64: fs.readFileSync(path.join(dir, f)).toString('base64'),
    }));
}

function bhId(title) {
  const m = title.match(/^BH-\d+/);
  return m ? m[0] : title;
}

function jiraTittelHtml(suiteTitle) {
  const tilskNummer = [...suiteTitle.matchAll(/TILSK-\d+/g)].map(m => m[0]);
  const linjer = tilskNummer
    .filter(t => jiraMetadata[t])
    .map(t => `<span class="jira-tittel-linje"><span class="jira-tag">${esc(t)}</span>${esc(jiraMetadata[t])}</span>`);
  return linjer.length
    ? `<div class="jira-tittel">${linjer.join('')}</div>`
    : '';
}

function erHoppetOver(spec) {
  return spec.tests?.some(t => t.status === 'skipped') ?? false;
}

function skipArsak(spec) {
  return spec.tests?.[0]?.annotations?.find(a => a.type === 'skip')?.description ?? '';
}

function sidemenyLinks() {
  return suites.map(suite => {
    const specs    = suite.specs ?? [];
    const feilet   = specs.filter(sp => !sp.ok).length;
    const hoppet   = specs.filter(sp => erHoppetOver(sp)).length;
    const cls      = feilet > 0 ? 'har-brudd' : hoppet > 0 ? 'har-hoppet' : 'ok';
    const id       = bhId(suite.title);
    const beskrivelse = suite.title.replace(id + ': ', '');
    const badgeTekst = feilet > 0
      ? `${feilet} feilet${hoppet > 0 ? ` · ${hoppet} hoppet over` : ''}`
      : hoppet > 0 ? `${hoppet} hoppet over`
      : 'OK';
    return `    <li>
      <a href="#bh-${esc(id)}" class="sidenav-link ${cls}">
        <span class="sidenavn">${esc(id)}</span>
        <span class="side-url">${esc(beskrivelse)}</span>
        <span class="side-badge">${esc(badgeTekst)}</span>
      </a>
    </li>`;
  }).join('\n');
}

function bhSeksjoner() {
  return suites.map(suite => {
    const specs = suite.specs ?? [];
    const antallFeilet  = specs.filter(sp => !sp.ok).length;
    const antallHoppet  = specs.filter(sp => erHoppetOver(sp)).length;
    const id = bhId(suite.title);
    const statusBadge = [
      antallFeilet > 0
        ? `<span class="badge critical">${antallFeilet} feilet</span>`
        : null,
      antallHoppet > 0
        ? `<span class="badge mangler-data">${antallHoppet} hoppet over – manglende testdata</span>`
        : null,
      antallFeilet === 0 && antallHoppet === 0
        ? `<span class="badge" style="background:#ecfdf5;color:#064e3b;">Alle OK</span>`
        : null,
    ].filter(Boolean).join(' ');

    const specRader = specs.map(spec => {
      const hoppet = erHoppetOver(spec);
      const ok     = spec.ok && !hoppet;
      const ikon   = hoppet ? '⚠️' : ok ? '✅' : '❌';
      const farge  = hoppet ? '#b45309' : ok ? '#064e3b' : '#c53030';
      const bg     = hoppet ? '#fffbeb' : ok ? '#ecfdf5' : '#fff5f5';
      const errors = spec.tests?.flatMap(t => t.results?.flatMap(r => r.errors ?? []) ?? []) ?? [];
      const errHtml = errors.length
        ? `<div class="brudd-hjelp">${esc(errors.map(e => e.message ?? '').join('\n\n')).replace(/\n/g, '<br>')}</div>`
        : '';
      const arsak = hoppet ? skipArsak(spec) : '';
      const arsakHtml = arsak
        ? `<div class="hoppet-arsak">Årsak: ${esc(arsak)}</div>`
        : '';
      const varighet = spec.tests?.[0]?.results?.[0]?.duration ?? 0;
      return `      <div class="brudd-kort" style="border-left-color:${farge};background:${bg};">
        <div class="brudd-header">
          <span>${ikon} <strong>${esc(spec.title)}</strong></span>
          <span class="brudd-teller">${varighet > 0 ? varighet + 'ms' : '–'}</span>
        </div>
        ${arsakHtml}
        ${errHtml}
      </div>`;
    }).join('\n');

    const skjermbilder = lesSkjermbilder(id);
    const skjermbildeHtml = skjermbilder.length > 0 ? `
    <div class="skjermbilde-galleri">
      <h3>Skjermbilder</h3>
      <div class="skjermbilde-grid">
        ${skjermbilder.map(s => `
        <figure class="skjermbilde-fig">
          <img src="data:image/png;base64,${s.base64}" alt="${esc(s.filnavn)}" class="skjermbilde">
          <figcaption>${esc(s.filnavn.replace(/^BH-\d+-/, '').replace(/-/g, ' ').replace('.png', ''))}</figcaption>
        </figure>`).join('')}
      </div>
    </div>` : '';

    return `  <section class="side-seksjon" id="bh-${esc(id)}">
    <div class="side-header">
      <div>
        <h2>${esc(suite.title)}</h2>
        ${jiraTittelHtml(suite.title)}
      </div>
      <div class="side-score-badges">${statusBadge}</div>
    </div>
    <div class="wcag-seksjon">
      <h3>Akseptansekriterier (${specs.length} tester)</h3>
${specRader}
    </div>
    ${skjermbildeHtml}
  </section>`;
  }).join('\n\n');
}

const html = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<script>if(location.protocol!=='file:'&&!sessionStorage.getItem('ks-auth'))location.replace('logg-inn.html?redir='+encodeURIComponent(location.href))</script>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brukerhistorietester – ${datotid}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#faf6f0;color:#0f0e17;display:flex;min-height:100vh}

  .sidemeny{width:272px;min-width:272px;background:#0a1355;color:white;padding:0;overflow-y:auto;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
  .sidemeny-header{padding:1.2rem 1.4rem;border-bottom:1px solid rgba(255,255,255,.1)}
  .sidemeny-logo{font-size:.7rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;opacity:.45;margin-bottom:.5rem}
  .env-badge{display:inline-block;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;background:rgba(255,255,255,.18);color:white;padding:.25rem .7rem;border-radius:100px;margin-top:.5rem}
  .sidemeny h1{font-size:.95rem;font-weight:600;line-height:1.3}
  .sidemeny h1 span{display:block;font-size:.72rem;opacity:.45;margin-top:.3rem;font-weight:400}
  .sidemeny ul{list-style:none;flex:1;overflow-y:auto;padding:.5rem 0}
  .sidenav-link{display:block;padding:.65rem 1.4rem;text-decoration:none;color:rgba(255,255,255,.65);border-left:3px solid transparent;transition:background .15s,color .15s}
  .sidenav-link:hover{background:rgba(255,255,255,.07);color:white}
  .sidenav-link.har-brudd{border-color:#f3dda2}
  .sidenav-link.har-hoppet{border-color:#fcd34d}
  .sidenav-link.ok{border-color:#abd1b1}
  .sidenavn{display:block;font-size:.84rem;font-weight:500}
  .side-url{display:block;font-size:.68rem;opacity:.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.15rem}
  .side-badge{display:block;font-size:.68rem;margin-top:.2rem;opacity:.6}

  .hoveddel{flex:1;padding:2.5rem 3rem;overflow-y:auto;max-width:1060px}

  .rapport-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:2rem;padding-bottom:1.5rem;border-bottom:2px solid #f4ecdf;flex-wrap:wrap}
  .rapport-header h1{font-size:1.5rem;font-weight:700;color:#0a1355;letter-spacing:-.01em}
  .rapport-header .meta{font-size:.85rem;color:#6b7280;margin-top:.4rem}
  .rapport-header .meta a{color:#07604f;text-decoration:none}
  .rapport-header .meta a:hover{text-decoration:underline}
  .nav-knapper{display:flex;gap:.6rem;flex-wrap:wrap;align-items:flex-start}
  .knapp{display:inline-block;padding:.5rem 1.2rem;background:#0a1355;color:white;border-radius:100px;font-size:.82rem;font-weight:500;text-decoration:none;white-space:nowrap;transition:background .15s}
  .knapp:hover{background:#2b3285}
  .knapp.aktiv{background:#07604f;pointer-events:none}
  .knapp.sekundær{background:transparent;border:1px solid #0a1355;color:#0a1355}
  .knapp.sekundær:hover{background:#f4ecdf}

  .seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .seksjon-tittel{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid #f4ecdf}
  .score-kort{background:white;border:1px solid #f1f0ee;padding:1.8rem 2rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .score-sirkel{width:88px;height:88px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:700;color:white;flex-shrink:0}
  .score-tekst strong{color:#0a1355;font-size:1rem}
  .score-tekst p{color:#6b7280;font-size:.87rem;margin-top:.35rem;line-height:1.5}

  .kort-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:.8rem;margin-bottom:2rem}
  .kort{background:white;padding:1.2rem 1rem;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .kort.kritisk{border-left-color:#c53030}
  .kort.ok{border-left-color:#07604f}
  .kort .tall{font-size:2rem;font-weight:700;margin:.3rem 0;color:#0a1355}
  .kort .etikett{font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .kort .undertekst{font-size:.7rem;color:#9ca3af;margin-top:.25rem}

  .side-seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .side-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.4rem;padding-bottom:1.2rem;border-bottom:1px solid #f4ecdf;flex-wrap:wrap;gap:.6rem}
  .side-header h2{font-size:1rem;font-weight:600;color:#0a1355}
  .jira-tittel{margin-top:.45rem;display:flex;flex-direction:column;gap:.2rem}
  .jira-tittel-linje{font-size:.8rem;color:#6b7280;font-style:italic;line-height:1.4}
  .jira-tag{font-size:.68rem;font-weight:700;font-style:normal;background:#eff6ff;color:#1d4ed8;padding:.1rem .45rem;border-radius:3px;margin-right:.4rem;letter-spacing:.01em}
  .side-score-badges{display:flex;gap:.4rem;flex-wrap:wrap;align-items:flex-start}

  .wcag-seksjon{margin-bottom:1.6rem}
  .wcag-seksjon h3{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:.9rem;padding-bottom:.4rem;border-bottom:1px solid #f4ecdf}
  .brudd-kort{border:1px solid #f1f0ee;border-left:4px solid #e5e3de;padding:1rem 1.1rem;margin-bottom:.7rem}
  .brudd-header{display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap;font-size:.9rem}
  .brudd-teller{font-size:.72rem;color:#9ca3af;white-space:nowrap;flex-shrink:0}
  .brudd-hjelp{font-size:.78rem;color:#555;margin-top:.5rem;padding:.5rem .8rem;background:#f4ecdf;border-left:3px solid #b8860b;white-space:pre-wrap}

  .badge{display:inline-block;padding:.15rem .6rem;border-radius:100px;font-size:.7rem;font-weight:600}
  .badge.critical{background:#fee2e2;color:#c53030}
  .badge.mangler-data{background:#fef3c7;color:#92400e}
  .hoppet-arsak{font-size:.78rem;color:#92400e;margin-top:.5rem;padding:.4rem .8rem;background:#fef9ec;border-left:3px solid #f59e0b;font-style:italic}

  .skjermbilde-galleri{margin-top:1.4rem}
  .skjermbilde-galleri h3{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:.9rem;padding-bottom:.4rem;border-bottom:1px solid #f4ecdf}
  .skjermbilde-grid{display:flex;flex-wrap:wrap;gap:1rem}
  .skjermbilde-fig{flex:1 1 260px;max-width:100%}
  .skjermbilde{width:100%;border:1px solid #e5e3de;border-radius:4px;box-shadow:0 2px 8px rgba(10,19,85,.1)}
  figcaption{font-size:.68rem;color:#9ca3af;margin-top:.3rem;text-transform:capitalize}

  footer{text-align:center;padding:2.5rem;color:#9ca3af;font-size:.78rem;border-top:1px solid #f1f0ee;margin-top:2rem}
</style>
</head>
<body>
<nav class="sidemeny">
  <div class="sidemeny-header">
    <div class="sidemeny-logo">KS Tilskudd · Brukerhistorietester</div>
    <div class="env-badge">PRODUKSJON</div>
    <h1>Brukerhistorie-rapport <span>${datotid} · ${suites.length} brukerhistorier</span></h1>
  </div>
  <ul>
${sidemenyLinks()}
  </ul>
</nav>

<main class="hoveddel">
  <header class="rapport-header">
    <div>
      <h1>Brukerhistorietester</h1>
      <div class="meta">
        <a href="${START_URL}" target="_blank" rel="noopener">${START_URL}</a>
        &nbsp;· ${datotid} · ${suites.length} brukerhistorier · @playwright/test
      </div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp sekundær">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="ytelse-rapport.html" class="knapp sekundær">Ytelsestest</a>
      <a href="brukerhistorie-rapport.html" class="knapp aktiv">Brukerhistorier</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
    </div>
  </header>

  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er brukerhistorietesting?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      Brukerhistorietester verifiserer at konkrete brukerscenarioer fungerer i applikasjonen.
      Hver test representerer én brukerhistorie med akseptansekriterier som automatisk verifiseres mot produksjonsmiljøet.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva testes</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>📋 Navigasjon og oversikt over utlysninger</li>
          <li>🔍 Søk etter tilskuddsordninger</li>
          <li>👤 Innlogget brukers «Min side»</li>
          <li>🔙 Tilbake-navigasjon og F5-refresh</li>
          <li>♿ Skiplink og hjelpemiddelteknologi</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva måles</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Antall bestatte akseptansekriterier</li>
          <li>Antall feilende akseptansekriterier</li>
          <li>Feilmelding og stack trace ved feil</li>
          <li>Skjermbilder ved feiling</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Verktøy og metode</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>@playwright/test (testramme)</li>
          <li>Innlogging via ID-porten (manuell)</li>
          <li>Kjøres mot produksjonsmiljøet</li>
          <li>Kjøres manuelt ved behov</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="score-kort">
    <div class="score-sirkel" style="background:${scoreFarge};">${pct}</div>
    <div class="score-tekst">
      <strong>${pct === 100 ? 'Alle tester bestatt' : `${totaltFeilet} test${totaltFeilet !== 1 ? 'er' : ''} feilet`}</strong>
      <p>${totaltBestatt} av ${totaltTester} tester bestatt på ${suites.length} brukerhistorier.<br>
      Varighet: ${((stats.duration ?? 0) / 1000).toFixed(1)}s totalt.</p>
    </div>
  </div>

  <div class="kort-grid">
    <div class="kort ok">
      <div class="etikett">Brukerhistorier</div>
      <div class="tall">${suites.length}</div>
      <div class="undertekst">Synlige i rapporten</div>
    </div>
    <div class="kort ok">
      <div class="etikett">Tester kjørt</div>
      <div class="tall">${totaltTester}</div>
      <div class="undertekst">Akseptansekriterier</div>
    </div>
    <div class="kort ok">
      <div class="etikett">Bestatt</div>
      <div class="tall">${totaltBestatt}</div>
      <div class="undertekst">expected</div>
    </div>
    <div class="kort ${totaltFeilet > 0 ? 'kritisk' : 'ok'}">
      <div class="etikett">Feilet</div>
      <div class="tall">${totaltFeilet}</div>
      <div class="undertekst">unexpected</div>
    </div>
  </div>

  <div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem;margin-bottom:-.2rem">
    <button onclick="document.querySelectorAll('details').forEach(d=>d.open=true)" style="background:transparent;border:1px solid #d1d5db;color:#374151;font-size:.75rem;padding:.3rem .85rem;border-radius:100px;cursor:pointer;font-family:inherit;transition:background .15s" onmouseover="this.style.background='#f4ecdf'" onmouseout="this.style.background='transparent'">↕ Åpne alle</button>
    <button onclick="document.querySelectorAll('details').forEach(d=>d.open=false)" style="background:transparent;border:1px solid #d1d5db;color:#374151;font-size:.75rem;padding:.3rem .85rem;border-radius:100px;cursor:pointer;font-family:inherit;transition:background .15s" onmouseover="this.style.background='#f4ecdf'" onmouseout="this.style.background='transparent'">↕ Lukk alle</button>
  </div>

${bhSeksjoner()}

  <footer>KS Tilskudd · Brukerhistorietester · @playwright/test · ${datotid}</footer>
</main>
</body>
</html>`;

fs.writeFileSync(utPath, html);
fs.writeFileSync(datoUtPath, html);

const jsonResultat = {
  url: START_URL,
  dato,
  score: pct,
  totalt: { bestått: totaltBestatt, feilet: totaltFeilet, totalt: totaltTester, suites: suites.length },
};
fs.writeFileSync(`${datoDir}/brukerhistorie-resultat.json`, JSON.stringify(jsonResultat, null, 2));

console.log(`Rapport skrevet til ${utPath} og ${datoUtPath}`);
