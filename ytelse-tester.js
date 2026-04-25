import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { START_URL, MAX_SIDER } from './config.js';
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = path.join(__dirname, 'rapporter', dato);
fs.mkdirSync(rapportDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;

console.log(`\n🚀 Starter ytelsestest av: ${START_URL}`);
console.log(`📅 Dato: ${dato}`);
console.log(`📄 Maks antall sider: ${MAX_SIDER}\n`);

// ── Score-funksjoner ──────────────────────────────────────────────────────────

function scoreLCP(ms)  { return ms <= 2500 ? 100 : ms <= 4000 ? Math.round(100 - (ms - 2500) / 15)  : Math.max(0, Math.round(50 - (ms - 4000) / 80));  }
function scoreFCP(ms)  { return ms <= 1800 ? 100 : ms <= 3000 ? Math.round(100 - (ms - 1800) / 12)  : Math.max(0, Math.round(50 - (ms - 3000) / 60));  }
function scoreTTFB(ms) { return ms <= 800  ? 100 : ms <= 1800 ? Math.round(100 - (ms - 800)  / 10)  : Math.max(0, Math.round(50 - (ms - 1800) / 36)); }
function scoreLoad(ms) { return ms <= 3000 ? 100 : ms <= 6000 ? Math.round(100 - (ms - 3000) / 30)  : Math.max(0, Math.round(50 - (ms - 6000) / 60));  }

function beregnScore(lcp, fcp, ttfb, load) {
  return Math.max(0, Math.round(0.4 * scoreLCP(lcp) + 0.2 * scoreFCP(fcp) + 0.2 * scoreTTFB(ttfb) + 0.2 * scoreLoad(load)));
}

// ── Formateringshjelpere ──────────────────────────────────────────────────────

function visTid(v)  { return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`; }
function visStr(kb) { return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`; }

function fargeLCP(v)  { return v <= 2500 ? 'god' : v <= 4000 ? 'middels' : 'dårlig'; }
function fargeFCP(v)  { return v <= 1800 ? 'god' : v <= 3000 ? 'middels' : 'dårlig'; }
function fargeTTFB(v) { return v <= 800  ? 'god' : v <= 1800 ? 'middels' : 'dårlig'; }
function fargeLoad(v) { return v <= 3000 ? 'god' : v <= 6000 ? 'middels' : 'dårlig'; }
function fargeStr(kb) { return kb <= 1024 ? 'god' : kb <= 3072 ? 'middels' : 'dårlig'; }
function fargeReq(n)  { return n <= 50   ? 'god' : n <= 100   ? 'middels' : 'dårlig'; }
function scoreKlasse(s) { return s >= 80 ? 'god' : s >= 50 ? 'middels' : 'dårlig'; }

// ── Crawl og mål ─────────────────────────────────────────────────────────────

const browser = await chromium.launch();
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 Ytelses-Tester/1.0',
  viewport: { width: 1280, height: 900 },
});

const besøkte = new Set();
const kø = [START_URL];
const sideResultater = [];

while (kø.length > 0 && sideResultater.length < MAX_SIDER) {
  const url = kø.shift();
  if (besøkte.has(url)) continue;
  besøkte.add(url);

  console.log(`  📄 [${sideResultater.length + 1}] ${url}`);

  const page = await context.newPage();

  // Observer for LCP og FCP må settes opp FØR navigasjon
  await page.addInitScript(() => {
    window.__lcp = 0;
    window.__fcp = 0;
    try {
      new PerformanceObserver(list => {
        const e = list.getEntries();
        if (e.length) window.__lcp = e[e.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries())
          if (e.name === 'first-contentful-paint') window.__fcp = e.startTime;
      }).observe({ type: 'paint', buffered: true });
    } catch {}
  });

  let ytelse = null;
  let lenker = [];

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {}); // gi LCP-observer tid til å registrere

    const data = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      return {
        ttfb:     nav ? Math.round(nav.responseStart - nav.requestStart) : 0,
        load:     nav ? Math.round(nav.loadEventEnd - nav.startTime)     : 0,
        sizeKB:   Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
        requests: res.length,
        lcp:      Math.round(window.__lcp || 0),
        fcp:      Math.round(window.__fcp || 0),
      };
    });

    const tittel = await page.title() || url;
    const score = beregnScore(data.lcp, data.fcp, data.ttfb, data.load);
    ytelse = { url, tittel, score, ...data };

    lenker = await page.evaluate(origin => {
      return [...new Set(
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => { try { return new URL(a.href, location.href).href.split('?')[0]; } catch { return null; } })
          .filter(h => h && h.startsWith(origin) && !h.includes('#'))
      )];
    }, baseOrigin);

    console.log(`     Score: ${score} | LCP: ${data.lcp}ms | FCP: ${data.fcp}ms | TTFB: ${data.ttfb}ms | Last: ${data.load}ms | ${data.sizeKB}KB | ${data.requests} req`);
  } catch (e) {
    console.log(`     ⚠️  Feil: ${e.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }

  if (ytelse) {
    sideResultater.push(ytelse);
    for (const l of lenker)
      if (!besøkte.has(l) && !kø.includes(l)) kø.push(l);
  }
}

await browser.close();

// ── Aggreger resultater ───────────────────────────────────────────────────────

const n = sideResultater.length;
const snitt = arr => n ? Math.round(arr.reduce((a, b) => a + b, 0) / n) : 0;

const samletScore = snitt(sideResultater.map(r => r.score));
const snittLCP    = snitt(sideResultater.map(r => r.lcp));
const snittFCP    = snitt(sideResultater.map(r => r.fcp));
const snittTTFB   = snitt(sideResultater.map(r => r.ttfb));
const snittLoad   = snitt(sideResultater.map(r => r.load));
const totalSizeKB = sideResultater.reduce((s, r) => s + r.sizeKB, 0);
const totalReq    = sideResultater.reduce((s, r) => s + r.requests, 0);

console.log(`\n✅ Ferdig! Score: ${samletScore}/100 | ${n} sider analysert`);

// ── Lagre JSON ────────────────────────────────────────────────────────────────

const jsonResultat = {
  url: START_URL,
  dato,
  tidspunkt,
  score: samletScore,
  totalt: { sider: n, snittLCP, snittFCP, snittTTFB, snittLoad, totalSizeKB, totalRequests: totalReq },
  sider: sideResultater,
};
fs.writeFileSync(path.join(rapportDir, 'ytelse-resultat.json'), JSON.stringify(jsonResultat, null, 2));
console.log(`📄 JSON lagret → rapporter/${dato}/ytelse-resultat.json`);

// ── Generer HTML-rapport ──────────────────────────────────────────────────────

// Hjelpefunksjon: konverter god/middels/dårlig til kort-klasse ok/advarsel/kritisk
function kortKlasse(farge) {
  if (farge === 'god') return 'ok';
  if (farge === 'middels') return 'advarsel';
  return 'kritisk';
}

// Sidebar-lenker for hver analysert side
const sideNavLenker = sideResultater.map((side, i) => {
  const sk = scoreKlasse(side.score);
  const navKlasse = sk === 'god' ? 'ok' : sk === 'middels' ? 'har-brudd' : 'har-kritiske';
  const anker = `side-${i}`;
  const kortNavn = side.tittel.length > 28 ? side.tittel.slice(0, 26) + '…' : side.tittel;
  return `<li><a href="#${anker}" class="sidenav-link ${navKlasse}">
    <span class="sidenavn">${kortNavn}</span>
    <span class="side-badge">Score: ${side.score}</span>
  </a></li>`;
}).join('');

// Tabellrader per side
const tabellRader = sideResultater.map((side, i) => `
  <tr id="side-${i}">
    <td class="url-col">
      <a href="${side.url}" target="_blank">${side.tittel}</a>
      <small>${side.url}</small>
    </td>
    <td class="score-col ${scoreKlasse(side.score)}">${side.score}</td>
    <td class="${fargeLCP(side.lcp)}">${visTid(side.lcp)}</td>
    <td class="${fargeFCP(side.fcp)}">${visTid(side.fcp)}</td>
    <td class="${fargeTTFB(side.ttfb)}">${visTid(side.ttfb)}</td>
    <td class="${fargeLoad(side.load)}">${visTid(side.load)}</td>
    <td class="${fargeStr(side.sizeKB)}">${visStr(side.sizeKB)}</td>
    <td class="${fargeReq(side.requests)}">${side.requests}</td>
  </tr>`).join('');

const rapportHTML = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ytelsesrapport – ${dato} ${tidspunkt}</title>
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
  .kort.kritisk{border-left-color:#c53030}.kort.advarsel{border-left-color:#b8860b}.kort.ok{border-left-color:#07604f}.kort.nøytral{border-left-color:#2b3285}
  .kort .tall{font-size:2rem;font-weight:700;margin:.3rem 0;color:#0a1355}
  .kort .etikett{font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .seksjon-tittel{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid #f4ecdf}
  .tabell-wrapper{background:white;border:1px solid #f1f0ee;box-shadow:0 1px 4px rgba(10,19,85,.06);overflow-x:auto;margin-bottom:1.5rem}
  table{width:100%;border-collapse:collapse;font-size:.83rem}
  th{background:#0a1355;color:white;padding:.7rem 1rem;text-align:left;font-weight:600;font-size:.75rem;white-space:nowrap}
  th small{display:block;font-weight:400;opacity:.6;font-size:.65rem;margin-top:1px}
  td{padding:.65rem 1rem;border-bottom:1px solid #f4f3f1;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#faf6f0}
  td.url-col{max-width:260px}
  td.url-col a{color:#0a1355;text-decoration:none;font-weight:500}
  td.url-col a:hover{text-decoration:underline}
  td.url-col small{color:#9ca3af;font-size:.72rem;display:block;margin-top:2px;word-break:break-all}
  td.score-col{font-weight:700;font-size:1rem;text-align:center;min-width:60px}
  td.score-col.god{color:white;background:#07604f}
  td.score-col.middels{color:#0a1355;background:#f3dda2}
  td.score-col.dårlig{color:white;background:#c53030}
  td.god{color:#07604f;font-weight:600}
  td.middels{color:#b8860b;font-weight:600}
  td.dårlig{color:#c53030;font-weight:600}
  .forklaring{font-size:.78rem;color:#6b7280;display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:2rem}
  .forklaring .god::before{content:'● ';color:#07604f}
  .forklaring .middels::before{content:'● ';color:#b8860b}
  .forklaring .dårlig::before{content:'● ';color:#c53030}
  footer{text-align:center;padding:2.5rem;color:#9ca3af;font-size:.78rem;border-top:1px solid #f1f0ee;margin-top:2rem}
</style>
</head>
<body>
<nav class="sidemeny">
  <div class="sidemeny-header">
    <div class="sidemeny-logo">KS Tilskudd · Ytelsestester</div>
    <div class="env-badge">PRODUKSJON</div>
    <h1>Ytelsesrapport <span>${dato} ${tidspunkt}</span></h1>
  </div>
  <ul>${sideNavLenker}</ul>
</nav>
<div class="hoveddel">
  <div class="rapport-header">
    <div>
      <h1>Ytelsesrapport</h1>
      <div class="meta"><a href="${START_URL}" target="_blank">${START_URL}</a> · ${dato} ${tidspunkt} · ${n} sider analysert · Playwright Chromium</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp sekundær">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="ytelse-rapport.html" class="knapp aktiv">Ytelsestest</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
    </div>
  </div>

  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er ytelsestesting?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      Ytelsestesten crawler applikasjonen og måler nøkkelberegninger for lastetid og brukeropplevelse på hver side.
      Testene kjøres med Playwright Chromium i et kontrollert miljø og gir et objektivt bilde av ytelsen.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva måles</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>⏱ LCP – Largest Contentful Paint</li>
          <li>🖼 FCP – First Contentful Paint</li>
          <li>📡 TTFB – Time To First Byte</li>
          <li>⚡ Lastetid (load-event)</li>
          <li>📦 Datastørrelse og antall forespørsler</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Terskelverdier</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>LCP: ≤ 2,5 s god · ≤ 4 s middels · &gt; 4 s dårlig</li>
          <li>FCP: ≤ 1,8 s god · ≤ 3 s middels · &gt; 3 s dårlig</li>
          <li>TTFB: ≤ 800 ms god · ≤ 1,8 s middels · &gt; 1,8 s dårlig</li>
          <li>Lastetid: ≤ 3 s god · ≤ 6 s middels · &gt; 6 s dårlig</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Scoringsvekter</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>LCP: 40 % av totalscoren</li>
          <li>FCP: 20 % av totalscoren</li>
          <li>TTFB: 20 % av totalscoren</li>
          <li>Lastetid: 20 % av totalscoren</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="score-kort">
    <div class="score-sirkel ${scoreKlasse(samletScore)}">${samletScore}</div>
    <div class="score-tekst">
      <strong>Samlet ytelsesscore – ${START_URL}</strong>
      <p>${n} sider analysert · Vektet snitt: LCP 40 %, FCP 20 %, TTFB 20 %, Lastetid 20 %<br>
      ${samletScore >= 80 ? 'God ytelse – applikasjonen laster raskt og gir en god brukeropplevelse.' : samletScore >= 50 ? 'Middels ytelse – det er rom for forbedringer på enkelte sider.' : 'Dårlig ytelse – applikasjonen bør optimaliseres for bedre lastetider.'}</p>
    </div>
  </div>

  <div class="kort-grid">
    <div class="kort ${kortKlasse(fargeLCP(snittLCP))}">
      <div class="etikett">Snitt LCP</div>
      <div class="tall">${visTid(snittLCP)}</div>
    </div>
    <div class="kort ${kortKlasse(fargeFCP(snittFCP))}">
      <div class="etikett">Snitt FCP</div>
      <div class="tall">${visTid(snittFCP)}</div>
    </div>
    <div class="kort ${kortKlasse(fargeTTFB(snittTTFB))}">
      <div class="etikett">Snitt TTFB</div>
      <div class="tall">${visTid(snittTTFB)}</div>
    </div>
    <div class="kort ${kortKlasse(fargeLoad(snittLoad))}">
      <div class="etikett">Snitt lastetid</div>
      <div class="tall">${visTid(snittLoad)}</div>
    </div>
    <div class="kort ${kortKlasse(fargeStr(totalSizeKB))}">
      <div class="etikett">Total størrelse</div>
      <div class="tall">${visStr(totalSizeKB)}</div>
    </div>
    <div class="kort ${kortKlasse(fargeReq(totalReq))}">
      <div class="etikett">Totalt forespørsler</div>
      <div class="tall">${totalReq}</div>
    </div>
  </div>

  <div class="tabell-wrapper">
    <table>
      <thead>
        <tr>
          <th>Side</th>
          <th>Score</th>
          <th>LCP<small>mål &lt; 2,5 s</small></th>
          <th>FCP<small>mål &lt; 1,8 s</small></th>
          <th>TTFB<small>mål &lt; 800 ms</small></th>
          <th>Lastetid<small>mål &lt; 3 s</small></th>
          <th>Størrelse<small>mål &lt; 1 MB</small></th>
          <th>Forespørsler<small>mål &lt; 50</small></th>
        </tr>
      </thead>
      <tbody>${tabellRader}</tbody>
    </table>
  </div>
  <div class="forklaring">
    <span class="god">God (innenfor mål)</span>
    <span class="middels">Middels (nær grensen)</span>
    <span class="dårlig">Bør forbedres (over grense)</span>
  </div>

  <div class="seksjon" style="margin-top:2rem">
    <div class="seksjon-tittel">Slik beregnes ytelsesscoren</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">LCP</span><span style="color:#0a1355;font-weight:700">× 40 % av totalscoren</span>
      <span style="color:#374151">FCP</span><span style="color:#0a1355;font-weight:700">× 20 % av totalscoren</span>
      <span style="color:#374151">TTFB</span><span style="color:#0a1355;font-weight:700">× 20 % av totalscoren</span>
      <span style="color:#374151">Lastetid</span><span style="color:#0a1355;font-weight:700">× 20 % av totalscoren</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Hver metrikk scores 0–100 basert på terskelverdiene &nbsp;·&nbsp; Score = vektet snitt per side &nbsp;·&nbsp; Totalscoren = snitt over alle sider &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>

  <details style="margin-top:2rem;border:1px solid #e5e3de;border-radius:.5rem;padding:1rem 1.2rem;background:#fafaf9">
    <summary style="cursor:pointer;font-size:.88rem;font-weight:600;color:#374151;user-select:none">Alle målinger som gjøres per side (6) ▾</summary>
    <div style="margin-top:1rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.2rem;font-size:.82rem">
      <div>
        <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem">Lastetidsmålinger</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
          <li style="color:#374151">· LCP – Largest Contentful Paint</li>
          <li style="color:#374151">· FCP – First Contentful Paint</li>
          <li style="color:#374151">· TTFB – Time To First Byte</li>
          <li style="color:#374151">· Lastetid (load-event ferdig)</li>
        </ul>
      </div>
      <div>
        <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem">Ressursmålinger</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
          <li style="color:#374151">· Total datastørrelse (transferSize)</li>
          <li style="color:#374151">· Antall nettverksforespørsler</li>
        </ul>
      </div>
    </div>
  </details>

  <footer>KS Tilskudd · Ytelsestest · Playwright Chromium</footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(rapportDir, 'ytelse-rapport.html'), rapportHTML);
console.log(`📊 Rapport lagret → rapporter/${dato}/ytelse-rapport.html`);
