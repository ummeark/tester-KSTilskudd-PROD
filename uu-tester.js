import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const START_URL = process.argv[2] || 'https://tilskudd.fiks.ks.no/';
const MAX_SIDER = parseInt(process.argv[3]) || 20;
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = path.join(__dirname, 'rapporter', dato);
const skjermDir = path.join(rapportDir, 'skjermbilder');
fs.mkdirSync(skjermDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;

console.log(`\n🔍 Starter UU-analyse av: ${START_URL}`);
console.log(`📅 Dato: ${dato}`);
console.log(`📄 Maks antall sider: ${MAX_SIDER}\n`);

const browser = await chromium.launch();
const nettleser = browser.version();
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 UU-Tester/1.0',
  viewport: { width: 1280, height: 900 }
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

const besøkte = new Set();
const kø = [START_URL];
const sideResultater = [];
let sideIndeks = 0;

// --- Ta skjermdump av et feilende element ---
async function taSkjermdump(page, selectors, filnavn, farge = '#dc3545') {
  try {
    // Marker alle feilende elementer
    await page.evaluate(({ selectors, farge }) => {
      selectors.forEach(sel => {
        try {
          const el = document.querySelector(sel);
          if (el) {
            el.setAttribute('data-uu-highlight', 'true');
            el.style.outline = `3px solid ${farge}`;
            el.style.outlineOffset = '2px';
            el.style.backgroundColor = farge === '#dc3545' ? 'rgba(220,53,69,0.08)' : 'rgba(255,193,7,0.12)';
          }
        } catch {}
      });
    }, { selectors, farge });

    // Prøv å ta nærbilde av første element
    let nærbilde = null;
    try {
      const el = await page.$(selectors[0]);
      if (el) {
        const boks = await el.boundingBox();
        if (boks && boks.width > 0 && boks.height > 0) {
          const nærFil = path.join(skjermDir, `${filnavn}-element.png`);
          await page.screenshot({
            path: nærFil,
            clip: {
              x: Math.max(0, boks.x - 20),
              y: Math.max(0, boks.y - 20),
              width: Math.min(boks.width + 40, 1280),
              height: Math.min(boks.height + 40, 600)
            }
          });
          nærbilde = `skjermbilder/${filnavn}-element.png`;
        }
      }
    } catch {}

    // Ta helsidebilde med kontekst
    const helFil = path.join(skjermDir, `${filnavn}-side.png`);
    await page.screenshot({ path: helFil, fullPage: false });
    const helside = `skjermbilder/${filnavn}-side.png`;

    // Fjern markering
    await page.evaluate(() => {
      document.querySelectorAll('[data-uu-highlight]').forEach(el => {
        el.removeAttribute('data-uu-highlight');
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.backgroundColor = '';
      });
    });

    return { nærbilde, helside };
  } catch {
    return { nærbilde: null, helside: null };
  }
}

async function analyserSide(url, indeks) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    const tittel = await page.title();

    // Finn og ekskluder versjonsnummer-element (f.eks. v0.4.3 / v.0.4.3)
    // Bruker CSS-attributtvelger på klassenavn som inneholder "version" / "Version"
    // samt tekstinnhold-sjekk (håndterer React sin <!-- --> kommentar-splitting)
    const versjonSelectors = await page.evaluate(() => {
      const resultat = new Set();

      // 1. Klasser som inneholder "version" eller "appVersion"
      document.querySelectorAll('[class]').forEach(el => {
        const cls = el.getAttribute('class') || '';
        if (/version/i.test(cls)) {
          const første = cls.trim().split(/\s+/)[0];
          resultat.add(`[class*="${første.replace(/"/g, '')}"]`);
        }
      });

      // 2. Tekstinnhold som matcher versjonsmønster (inkl. React-splittet tekst)
      const mønster = /^v\.?\d+\.\d+\.\d+$/i;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const tekst = node.textContent.trim();
        if (mønster.test(tekst)) {
          let el = node.parentElement;
          for (let i = 0; i < 3 && el && el !== document.body; i++) {
            if (el.id) { resultat.add(`#${el.id}`); break; }
            const cls = el.getAttribute('class');
            if (cls) { resultat.add(`[class="${cls}"]`); break; }
            el = el.parentElement;
          }
        }
      }
      return [...resultat];
    });

    // Axe WCAG-analyse med ekskludering av versjonslement
    let axeBuilder = new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']);
    for (const sel of versjonSelectors) {
      try { axeBuilder = axeBuilder.exclude(sel); } catch {}
    }
    const axeRå = await axeBuilder.analyze();

    // Post-filtrer: fjern også violations der HTML på noden inneholder versjonsmønster
    // (håndterer tilfeller der axe.exclude() ikke fanger opp elementet)
    const axe = {
      ...axeRå,
      violations: axeRå.violations.filter(v =>
        !v.nodes.every(n => /version/i.test(n.html || '') || /v[\s\S]*?\d+\.\d+\.\d+/.test(n.html || ''))
      )
    };

    // Ta skjermdump av hvert WCAG-brudd
    console.log(`  📸 Tar skjermdumper av ${axe.violations.length} brudd...`);
    const violasjonerMedBilder = [];
    for (let vi = 0; vi < axe.violations.length; vi++) {
      const v = axe.violations[vi];
      const selectors = v.nodes.flatMap(n => n.target).slice(0, 5);
      const filnavn = `s${indeks}-${v.id.replace(/[^a-z0-9]/gi, '-')}-${vi}`;
      const farge = v.impact === 'critical' ? '#dc3545' : v.impact === 'serious' ? '#fd7e14' : '#ffc107';
      const bilder = await taSkjermdump(page, selectors, filnavn, farge);
      violasjonerMedBilder.push({ ...v, bilder });
    }

    // Finn interne lenker
    const internelenker = await page.evaluate((origin) =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.startsWith(origin) && !href.includes('#'))
        .map(href => href.split('?')[0].replace(/\/$/, '') || '/')
    , baseOrigin);

    // Lenkesjekk
    const allelenker = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        tekst: a.innerText.trim() || a.getAttribute('aria-label') || '(ingen tekst)',
        href: a.href,
        intern: a.href.startsWith(window.location.origin),
        harTekst: !!(a.innerText.trim() || a.getAttribute('aria-label'))
      }))
    );

    const lenkeSjekk = await Promise.all(
      allelenker.map(async (l) => {
        if (!l.href || l.href.startsWith('mailto:') || l.href.startsWith('tel:') || l.href.startsWith('javascript:')) {
          return { ...l, status: 'skip', ok: true };
        }
        try {
          const r = await fetch(l.href, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
          return { ...l, status: r.status, ok: r.ok };
        } catch {
          try {
            const r = await fetch(l.href, { method: 'GET', signal: AbortSignal.timeout(6000) });
            return { ...l, status: r.status, ok: r.ok };
          } catch {
            return { ...l, status: 'feil', ok: false };
          }
        }
      })
    );

    // Skjermdump av sider med døde lenker
    const dødeLenker = lenkeSjekk.filter(l => !l.ok && l.status !== 'skip');
    if (dødeLenker.length > 0) {
      const dødFil = `s${indeks}-doede-lenker`;
      const dødSelectors = dødeLenker.map(l => `a[href="${l.href}"]`).slice(0, 5);
      const dødBilder = await taSkjermdump(page, dødSelectors, dødFil, '#6c757d');
      dødeLenker.forEach(l => { l.bilder = dødBilder; });
    }

    // Knapper
    const knapper = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"]'))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          tekst: el.innerText?.trim() || el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || '',
          harLabel: !!(el.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value')),
          disabled: el.disabled || false
        }))
    );

    // Bilder
    const bilder = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.src.split('/').pop() || img.src,
        fullSrc: img.src,
        alt: img.getAttribute('alt') ?? null,
        harAlt: img.hasAttribute('alt'),
        altErTom: img.getAttribute('alt') === '',
        rolle: img.getAttribute('role') || '',
        bredde: img.naturalWidth,
        høyde: img.naturalHeight
      }))
    );

    // Skjemafelt
    const skjemafelt = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(el => !['hidden', 'submit', 'button', 'reset'].includes(el.type))
        .map(el => {
          const id = el.id;
          const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
          const foreldreLabel = el.closest('label');
          const labelTekst = labelEl?.innerText?.trim() || foreldreLabel?.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
          return {
            type: el.type || el.tagName.toLowerCase(),
            id: id || '(ingen id)',
            navn: el.getAttribute('name') || '',
            labelTekst,
            påkrevd: el.required || false,
            harLabel: !!(labelEl || foreldreLabel || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'))
          };
        })
    );

    // Struktur
    const struktur = await page.evaluate(() => {
      const overskrifter = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
        nivå: parseInt(h.tagName[1]),
        tekst: h.innerText.trim().slice(0, 100)
      }));
      const landmarks = Array.from(document.querySelectorAll('main, nav, header, footer, aside, section[aria-label], [role="main"], [role="navigation"], [role="banner"]'))
        .map(el => ({ tag: el.tagName.toLowerCase(), rolle: el.getAttribute('role') || el.tagName.toLowerCase(), label: el.getAttribute('aria-label') || '' }));
      const harSkipLink = !!document.querySelector('a[href="#main"], a[href="#innhold"], a[href="#content"]');
      const langAttr = document.documentElement.getAttribute('lang') || '';
      return { overskrifter, landmarks, harSkipLink, langAttr };
    });

    await page.close();

    return {
      url, tittel,
      wcag: {
        brudd: axe.violations.length,
        bestått: axe.passes.length,
        kritiske: axe.violations.filter(v => v.impact === 'critical').length,
        alvorlige: axe.violations.filter(v => v.impact === 'serious').length,
        moderate: axe.violations.filter(v => v.impact === 'moderate').length,
        mindre: axe.violations.filter(v => v.impact === 'minor').length,
        detaljer: violasjonerMedBilder
      },
      lenker: {
        totalt: lenkeSjekk.filter(l => l.status !== 'skip').length,
        døde: dødeLenker,
        tomTekst: lenkeSjekk.filter(l => !l.harTekst && l.status !== 'skip'),
        alle: lenkeSjekk
      },
      knapper, bilder, skjemafelt, struktur,
      internelenker: [...new Set(internelenker)]
    };
  } catch (e) {
    await page.close();
    console.log(`  ⚠️  Kunne ikke laste: ${url} (${e.message.slice(0, 60)})`);
    return null;
  }
}

// ── Tastaturnavigasjonstest ───────────────────────────────────────────────────

async function kjørTastaturSjekker(ctx, url) {
  console.log('\n⌨️  Kjører tastaturnavigasjonstest...');
  const tester = [];
  const page = await ctx.newPage();

  function add(kategori, wcag, navn, resultat, detalj = '') {
    tester.push({ kategori, wcag, navn, resultat, detalj });
    const ikon = { bestått: '✅', feil: '❌', advarsel: '⚠️' }[resultat] || '⚪';
    console.log(`  ${ikon} [${wcag}] ${navn}${detalj ? ` – ${detalj}` : ''}`);
  }

  try {
    // 2.4.7 Synlig fokus
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const utenFokus = [];
    let forrigeKey = null;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const st = window.getComputedStyle(el);
        const harOutline = st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0;
        const harBoxShadow = st.boxShadow !== 'none' && st.boxShadow !== '';
        const key = `${el.tagName}|${(el.textContent?.trim() || el.getAttribute('aria-label') || '').slice(0, 40)}`;
        return { key, synlig: harOutline || harBoxShadow,
          tag: el.tagName, tekst: (el.textContent?.trim() || el.getAttribute('aria-label') || '').slice(0, 50) };
      });
      if (!info || info.key === forrigeKey) continue;
      forrigeKey = info.key;
      if (!info.synlig) utenFokus.push(`${info.tag} "${info.tekst}"`);
    }
    if (utenFokus.length > 0) {
      add('synligfokus', '2.4.7', 'Synlig fokus på interaktive elementer', 'advarsel',
        `${utenFokus.length} element(er) uten synlig fokus: ${utenFokus.slice(0, 2).join(', ')}`);
    } else {
      add('synligfokus', '2.4.7', 'Synlig fokus på interaktive elementer', 'bestått');
    }

    // 2.4.3 Tabindeks-misbruk
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const misbruk = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[tabindex]'))
        .filter(el => parseInt(el.getAttribute('tabindex'), 10) > 0)
        .map(el => `${el.tagName}[tabindex=${el.getAttribute('tabindex')}]`)
    );
    if (misbruk.length > 0) {
      add('tabindeks', '2.4.3', 'Elementer med tabindex > 0', 'advarsel',
        `${misbruk.length} element(er): ${misbruk.slice(0, 3).join(', ')}`);
    } else {
      add('tabindeks', '2.4.3', 'Ingen tabindex > 0', 'bestått');
    }

    // 2.1.1 Tastaturrekkevidde
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const interaktiveDOM = await page.evaluate(() =>
      document.querySelectorAll('a[href]:not([tabindex="-1"]),button:not([tabindex="-1"]):not([disabled]),input:not([type=hidden]):not([tabindex="-1"])').length
    );
    const nådd = new Set();
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(50);
      const id = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return `${el.tagName}|${el.getAttribute('href') || el.textContent?.trim().slice(0, 25) || ''}`;
      });
      if (id) nådd.add(id);
    }
    if (nådd.size === 0) {
      add('rekkevidden', '2.1.1', 'Interaktive elementer nåbare via Tab', 'feil', 'Ingen elementer fokusert med Tab');
    } else if (nådd.size < 3 && interaktiveDOM > 5) {
      add('rekkevidden', '2.1.1', 'Interaktive elementer nåbare via Tab', 'advarsel',
        `Kun ${nådd.size} av ~${interaktiveDOM} elementer nådd`);
    } else {
      add('rekkevidden', '2.1.1', 'Interaktive elementer nåbare via Tab', 'bestått',
        `${nådd.size} elementer nådd (${interaktiveDOM} i DOM)`);
    }

    // 2.1.2 Ingen tastaturfelle
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let forrigeId = null, konsekutive = 0, felle = null;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(70);
      const id = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}|${el.getAttribute('href') || el.id || el.textContent?.trim().slice(0, 20)}` : null;
      });
      if (id === forrigeId) { if (++konsekutive >= 3) { felle = id; break; } }
      else { konsekutive = 0; forrigeId = id; }
    }
    if (felle) {
      add('tastaturfelle', '2.1.2', 'Ingen tastaturfelle', 'feil', `Fokus fast ved: "${felle}"`);
    } else {
      add('tastaturfelle', '2.1.2', 'Ingen tastaturfelle', 'bestått');
    }

    // 2.4.1 Hopplenke til hovedinnhold
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate(() => document.body.focus());
    await page.waitForTimeout(100);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    const hoppInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const tekst = (el.textContent?.trim() || el.getAttribute('aria-label') || '').toLowerCase();
      const href = el.getAttribute('href') || '';
      return { tag: el.tagName, tekst,
        erHopp: tekst.includes('hopp') || tekst.includes('skip') || tekst.includes('innhold') || (href.startsWith('#') && el.tagName === 'A') };
    });
    if (!hoppInfo || !hoppInfo.erHopp) {
      add('hopplenke', '2.4.1', 'Hopplenke til hovedinnhold', 'advarsel',
        hoppInfo ? `Første Tab: ${hoppInfo.tag} "${hoppInfo.tekst}"` : 'Ingen element fokusert etter første Tab');
    } else {
      add('hopplenke', '2.4.1', 'Hopplenke til hovedinnhold', 'bestått', `"${hoppInfo.tekst}"`);
    }

    // 2.1.1 Enter aktiverer lenker
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const utgangsUrl = page.url();
    let aktivert = false;
    for (let i = 0; i < 15 && !aktivert; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(70);
      const erNavLenke = await page.evaluate(() => {
        const el = document.activeElement;
        if (el?.tagName !== 'A') return false;
        const href = el.getAttribute('href') || '';
        return href.length > 0 && !href.startsWith('#') && !href.startsWith('javascript') && !href.startsWith('mailto');
      });
      if (erNavLenke) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        aktivert = page.url() !== utgangsUrl;
        break;
      }
    }
    add('aktivering', '2.1.1', 'Enter aktiverer navigasjonslenke', aktivert ? 'bestått' : 'advarsel',
      aktivert ? '' : 'Ingen navigasjonslenke aktivert i de første 15 Tab-stegene');

  } catch (e) {
    console.log(`  ⚠️  Tastatursjekk feilet: ${e.message.slice(0, 80)}`);
  } finally {
    await page.close();
  }

  const bestått = tester.filter(t => t.resultat === 'bestått').length;
  const feil    = tester.filter(t => t.resultat === 'feil').length;
  const advarsel = tester.filter(t => t.resultat === 'advarsel').length;
  return { tester, bestått, feil, advarsel };
}

// Crawl alle sider
while (kø.length > 0 && besøkte.size < MAX_SIDER) {
  const url = kø.shift();
  const normUrl = url.replace(/\/$/, '') || START_URL;
  if (besøkte.has(normUrl)) continue;
  besøkte.add(normUrl);
  sideIndeks++;

  console.log(`📄 [${besøkte.size}/${MAX_SIDER}] Analyserer: ${normUrl}`);
  const resultat = await analyserSide(normUrl, sideIndeks);
  if (resultat) {
    sideResultater.push(resultat);
    for (const lenke of resultat.internelenker) {
      const norm = lenke.replace(/\/$/, '');
      if (!besøkte.has(norm) && !kø.includes(norm)) kø.push(norm);
    }
  }
}

const tastatur = await kjørTastaturSjekker(context, START_URL);

await browser.close();

// Aggregert oppsummering
const totalt = {
  sider: sideResultater.length,
  wcagBrudd: sideResultater.reduce((s, r) => s + r.wcag.brudd, 0),
  kritiske: sideResultater.reduce((s, r) => s + r.wcag.kritiske, 0),
  alvorlige: sideResultater.reduce((s, r) => s + r.wcag.alvorlige, 0),
  moderate: sideResultater.reduce((s, r) => s + r.wcag.moderate, 0),
  mindre: sideResultater.reduce((s, r) => s + r.wcag.mindre, 0),
  dødelenker: sideResultater.reduce((s, r) => s + r.lenker.døde.length, 0),
  knapper: sideResultater.reduce((s, r) => s + r.knapper.length, 0),
  knappUtenLabel: sideResultater.reduce((s, r) => s + r.knapper.filter(k => !k.harLabel).length, 0),
  bilder: sideResultater.reduce((s, r) => s + r.bilder.length, 0),
  bilderUtenAlt: sideResultater.reduce((s, r) => s + r.bilder.filter(b => !b.harAlt).length, 0),
  skjemafelt: sideResultater.reduce((s, r) => s + r.skjemafelt.length, 0),
  feltUtenLabel: sideResultater.reduce((s, r) => s + r.skjemafelt.filter(f => !f.harLabel).length, 0),
  tastaturFeil: tastatur.feil,
  tastaturAdvarsel: tastatur.advarsel,
};

// Lagre JSON (uten bildedata for å holde størrelsen nede)
fs.writeFileSync(path.join(rapportDir, 'resultat.json'), JSON.stringify({ url: START_URL, dato, versjon, nettleser, totalt, tastatur, sider: sideResultater.map(s => ({ ...s, wcag: { ...s.wcag, detaljer: s.wcag.detaljer.map(v => ({ ...v, bilder: v.bilder })) } })) }, null, 2));

// Generer HTML
fs.writeFileSync(path.join(rapportDir, 'uu-rapport.html'), genererRapport(START_URL, dato, tidspunkt, totalt, sideResultater, versjon, tastatur, nettleser));

// Lagre tidsstemplet kopi for arkiv (bevarer alle kjøringer samme dag)
const tidFil = tidspunkt.replace(':', '-');
fs.copyFileSync(path.join(rapportDir, 'resultat.json'), path.join(rapportDir, `resultat-${tidFil}.json`));
fs.copyFileSync(path.join(rapportDir, 'uu-rapport.html'), path.join(rapportDir, `uu-rapport-${tidFil}.html`));

// Terminal
console.log('\n' + '━'.repeat(60));
console.log(`📊 RAPPORT – ${START_URL}`);
console.log('━'.repeat(60));
console.log(`📄 Sider testet:     ${totalt.sider}`);
console.log(`♿ WCAG-brudd:       ${farge(totalt.wcagBrudd, 0, 3, 8)}   (kritiske: ${totalt.kritiske}, alvorlige: ${totalt.alvorlige})`);
console.log(`🔗 Døde lenker:      ${farge(totalt.dødelenker, 0, 1, 5)}`);
console.log(`🔘 Knapper testet:   ${totalt.knapper} (${farge(totalt.knappUtenLabel, 0, 1, 3)} uten label)`);
console.log(`🖼️  Bilder testet:    ${totalt.bilder} (${farge(totalt.bilderUtenAlt, 0, 1, 3)} uten alt)`);
console.log(`📝 Skjemafelt:       ${totalt.skjemafelt} (${farge(totalt.feltUtenLabel, 0, 1, 3)} uten label)`);
console.log(`⌨️  Tastatur:         ${tastatur.bestått} bestått · ${farge(tastatur.advarsel, 0, 0, 2)} adv. · ${farge(tastatur.feil, 0, 0, 1)} feil`);
console.log('━'.repeat(60));
console.log(`\n📁 HTML-rapport: ${path.join(rapportDir, 'uu-rapport.html')}\n`);
const { exec } = await import('child_process');
exec(`open "${path.join(rapportDir, 'uu-rapport.html')}"`);

function farge(n, grønn, gul, rød) {
  if (n <= grønn) return `\x1b[32m${n}\x1b[0m`;
  if (n <= gul) return `\x1b[33m${n}\x1b[0m`;
  return `\x1b[31m${n}\x1b[0m`;
}

function scoreBeregn(t) {
  return Math.max(0, 100 - t.kritiske * 15 - t.alvorlige * 8 - t.moderate * 3 - t.mindre - t.dødelenker * 5 - t.knappUtenLabel * 4 - t.bilderUtenAlt * 4 - t.feltUtenLabel * 4 - (t.tastaturFeil || 0) * 15 - (t.tastaturAdvarsel || 0) * 5);
}

function badge(n, klasse, tekst) {
  if (n === 0) return '';
  return `<span class="badge ${klasse}">${n} ${tekst}</span>`;
}

function impactFarge(impact) {
  return { critical: '#c53030', serious: '#9a3412', moderate: '#b8860b', minor: '#6b7280' }[impact] || '#6b7280';
}

function genererRapport(url, dato, tidspunkt, totalt, sider, versjon = null, tastatur = { tester: [], bestått: 0, feil: 0, advarsel: 0 }, nettleser = '') {
  const s = scoreBeregn(totalt);
  const scoreKlasse = s >= 80 ? 'god' : s >= 50 ? 'middels' : 'dårlig';

  const sidenavigasjon = sider.map((side, i) =>
    `<li><a href="#side-${i}" class="sidenav-link ${side.wcag.kritiske > 0 ? 'har-kritiske' : side.wcag.brudd > 0 ? 'har-brudd' : 'ok'}">
      <span class="sidenavn">${side.tittel || side.url}</span>
      <span class="side-url">${side.url.replace(url.replace(/\/$/, ''), '') || '/'}</span>
      <span class="side-badge">${side.wcag.brudd > 0 ? `${side.wcag.brudd} brudd` : '✅'}</span>
    </a></li>`
  ).join('');

  const sideDetaljer = sider.map((side, i) => `
    <div class="side-seksjon" id="side-${i}">
      <div class="side-header">
        <div>
          <h2>${side.tittel || '(ingen tittel)'}</h2>
          <a href="${side.url}" target="_blank" class="side-url-link">${side.url}</a>
        </div>
        <div class="side-score-badges">
          ${badge(side.wcag.kritiske, 'critical', 'kritiske')}
          ${badge(side.wcag.alvorlige, 'serious', 'alvorlige')}
          ${badge(side.lenker.døde.length, 'dead', 'døde lenker')}
        </div>
      </div>

      <!-- WCAG-brudd med skjermdumper -->
      <div class="wcag-seksjon">
        <h3>♿ WCAG-brudd (${side.wcag.brudd})</h3>
        ${side.wcag.detaljer.length === 0
          ? '<div class="wcag-ok">✅ Ingen WCAG-brudd på denne siden</div>'
          : side.wcag.detaljer.map(v => `
            <div class="brudd-kort" style="border-left-color: ${impactFarge(v.impact)}">
              <div class="brudd-header">
                <div>
                  <span class="badge ${v.impact}">${v.impact}</span>
                  <code class="regel-id">${v.id}</code>
                  <span class="regel-desc">${v.description}</span>
                </div>
                <span class="brudd-teller">${v.nodes.length} element${v.nodes.length !== 1 ? 'er' : ''}</span>
              </div>
              ${v.help ? `<p class="brudd-hjelp">💡 ${v.help} — <a href="${v.helpUrl}" target="_blank">Les mer</a></p>` : ''}
              ${v.nodes.slice(0, 3).map(n => `
                <div class="node-info">
                  <code class="node-selector">${Array.isArray(n.target) ? n.target.join(' > ') : n.target}</code>
                  ${n.failureSummary ? `<p class="failure-summary">${n.failureSummary.replace('Fix any of the following:\n', '').replace('Fix all of the following:\n', '').trim()}</p>` : ''}
                </div>`).join('')}
              ${v.bilder?.nærbilde || v.bilder?.helside ? `
              <div class="skjermdump-gruppe">
                ${v.bilder.nærbilde ? `
                  <div class="skjermdump-wrapper">
                    <p class="skjermdump-label">📍 Nærbilde av feilende element</p>
                    <a href="${v.bilder.nærbilde}" target="_blank">
                      <img src="${v.bilder.nærbilde}" alt="Nærbilde av feilende element for ${v.id}" class="skjermdump nærbilde" loading="lazy">
                    </a>
                  </div>` : ''}
                ${v.bilder.helside ? `
                  <div class="skjermdump-wrapper">
                    <p class="skjermdump-label">🖥️ Sidekontekst (element markert)</p>
                    <a href="${v.bilder.helside}" target="_blank">
                      <img src="${v.bilder.helside}" alt="Skjermdump av siden med feilende element markert" class="skjermdump helside" loading="lazy">
                    </a>
                  </div>` : ''}
              </div>` : ''}
            </div>`).join('')}
      </div>

      <!-- Døde lenker med skjermdump -->
      ${side.lenker.døde.length > 0 ? `
      <div class="wcag-seksjon">
        <h3>🔗 Døde lenker (${side.lenker.døde.length})</h3>
        ${side.lenker.døde.map(l => `
          <div class="brudd-kort" style="border-left-color:#6c757d">
            <div class="brudd-header">
              <div><span class="badge dead">${l.status}</span> <span>${l.tekst}</span></div>
            </div>
            <code class="node-selector">${l.href}</code>
            ${l.bilder?.helside ? `
            <div class="skjermdump-gruppe">
              <div class="skjermdump-wrapper">
                <p class="skjermdump-label">🖥️ Siden med den døde lenken markert</p>
                <a href="${l.bilder.helside}" target="_blank">
                  <img src="${l.bilder.helside}" alt="Skjermdump som viser plasseringen av den døde lenken" class="skjermdump helside" loading="lazy">
                </a>
              </div>
            </div>` : ''}
          </div>`).join('')}
      </div>` : ''}

      <!-- Artefakter -->
      <div class="artefakt-grid">
        <div class="artefakt-kort">
          <h3>🏗️ Sidestruktur</h3>
          <table><tbody>
            <tr><td>Språkattributt</td><td>${side.struktur.langAttr ? `<code>${side.struktur.langAttr}</code> ✅` : '<span class="mangler">Mangler ❌</span>'}</td></tr>
            <tr><td>Skip-lenke</td><td>${side.struktur.harSkipLink ? '✅ Funnet' : '<span class="mangler">Mangler ❌</span>'}</td></tr>
            <tr><td>Landmarks</td><td>${side.struktur.landmarks.length > 0 ? side.struktur.landmarks.map(l => `<code>${l.tag}</code>`).join(' ') : '<span class="mangler">Ingen ❌</span>'}</td></tr>
          </tbody></table>
          ${side.struktur.overskrifter.length > 0 ? `
          <h4 style="margin-top:0.8rem">Overskriftshierarki</h4>
          <ul class="overskrift-liste">
            ${side.struktur.overskrifter.map(h => `<li style="padding-left:${(h.nivå-1)}rem"><span class="h-badge">H${h.nivå}</span> ${h.tekst}</li>`).join('')}
          </ul>` : ''}
        </div>
        <div class="artefakt-kort">
          <h3>🔘 Knapper testet (${side.knapper.length})</h3>
          ${side.knapper.length === 0 ? '<p class="ingen">Ingen knapper funnet</p>'
            : `<table><thead><tr><th>Element</th><th>Tekst/Label</th><th>Status</th></tr></thead><tbody>
            ${side.knapper.map(k => `<tr>
              <td><code>${k.tag}${k.type ? `[${k.type}]` : ''}</code></td>
              <td>${k.tekst || '<em>(ingen)</em>'}</td>
              <td>${k.harLabel ? '✅' : '<span class="mangler">❌ Mangler</span>'}</td>
            </tr>`).join('')}</tbody></table>`}
        </div>
        <div class="artefakt-kort">
          <h3>🖼️ Bilder testet (${side.bilder.length})</h3>
          ${side.bilder.length === 0 ? '<p class="ingen">Ingen bilder funnet</p>'
            : `<table><thead><tr><th>Fil</th><th>Alt-tekst</th><th>Status</th></tr></thead><tbody>
            ${side.bilder.map(b => `<tr>
              <td style="font-size:0.8rem">${b.src.slice(0, 35)}</td>
              <td>${b.alt !== null ? (b.alt || '<em>(tom)</em>') : '<em>(ikke satt)</em>'}</td>
              <td>${b.harAlt ? (b.altErTom ? '⚠️ Tom' : '✅') : '<span class="mangler">❌ Mangler</span>'}</td>
            </tr>`).join('')}</tbody></table>`}
        </div>
        ${side.skjemafelt.length > 0 ? `
        <div class="artefakt-kort">
          <h3>📝 Skjemafelt testet (${side.skjemafelt.length})</h3>
          <table><thead><tr><th>Type</th><th>ID</th><th>Label</th><th>Status</th></tr></thead><tbody>
          ${side.skjemafelt.map(f => `<tr>
            <td><code>${f.type}</code></td>
            <td><code>${f.id !== '(ingen id)' ? f.id : f.navn || '—'}</code></td>
            <td>${f.labelTekst || '<em>(ingen)</em>'}</td>
            <td>${f.harLabel ? '✅' : '<span class="mangler">❌ Mangler</span>'}</td>
          </tr>`).join('')}</tbody></table>
        </div>` : ''}
        <div class="artefakt-kort">
          <h3>🔗 Lenker sjekket (${side.lenker.totalt})</h3>
          ${side.lenker.døde.length === 0
            ? '<p class="ok-tekst">✅ Ingen døde lenker</p>'
            : `<table><thead><tr><th>Status</th><th>Tekst</th><th>URL</th></tr></thead><tbody>
            ${side.lenker.døde.map(l => `<tr>
              <td><span class="badge dead">${l.status}</span></td>
              <td>${l.tekst.slice(0, 30)}</td>
              <td style="font-size:0.75rem;word-break:break-all">${l.href}</td>
            </tr>`).join('')}</tbody></table>`}
        </div>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UU-rapport – ${dato} ${tidspunkt}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#faf6f0;color:#0f0e17;display:flex;min-height:100vh}

  /* Sidebar */
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
  .sidenavn{display:block;font-size:.84rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .side-url{display:block;font-size:.68rem;opacity:.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.15rem}
  .side-badge{display:block;font-size:.68rem;margin-top:.2rem;opacity:.6}

  /* Main */
  .hoveddel{flex:1;padding:2.5rem 3rem;overflow-y:auto;max-width:1060px}

  /* Top header */
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

  /* Score card */
  .score-kort{background:white;border:1px solid #f1f0ee;padding:1.8rem 2rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .score-sirkel{width:88px;height:88px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:700;flex-shrink:0}
  .score-sirkel.god{background:#07604f;color:white}
  .score-sirkel.middels{background:#f3dda2;color:#0a1355}
  .score-sirkel.dårlig{background:#c53030;color:white}
  .score-tekst strong{color:#0a1355;font-size:1rem}
  .score-tekst p{color:#6b7280;font-size:.87rem;margin-top:.35rem;line-height:1.5}

  /* Metric cards */
  .kort-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:.8rem;margin-bottom:2rem}
  .kort{background:white;padding:1.2rem 1rem;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .kort.kritisk{border-left-color:#c53030}.kort.advarsel{border-left-color:#b8860b}.kort.ok{border-left-color:#07604f}
  .kort .tall{font-size:2rem;font-weight:700;margin:.3rem 0;color:#0a1355}
  .kort .etikett{font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .kort .undertekst{font-size:.7rem;color:#9ca3af;margin-top:.25rem}

  /* Info-seksjon (Hva er UU-testing?) */
  .seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .seksjon-tittel{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid #f4ecdf}

  /* Page sections */
  .side-seksjon{background:white;border:1px solid #f1f0ee;padding:2rem;margin-bottom:1.2rem;box-shadow:0 1px 4px rgba(10,19,85,.06)}
  .side-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.4rem;padding-bottom:1.2rem;border-bottom:1px solid #f4ecdf;flex-wrap:wrap;gap:.6rem}
  .side-header h2{font-size:1rem;font-weight:600;color:#0a1355}
  .side-url-link{font-size:.78rem;color:#07604f;text-decoration:none;display:block;margin-top:.2rem}
  .side-url-link:hover{text-decoration:underline}
  .side-score-badges{display:flex;gap:.4rem;flex-wrap:wrap;align-items:flex-start}

  /* WCAG sections */
  .wcag-seksjon{margin-bottom:1.6rem}
  .wcag-seksjon h3{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:.9rem;padding-bottom:.4rem;border-bottom:1px solid #f4ecdf}
  .brudd-kort{background:#faf6f0;border:1px solid #f1f0ee;border-left:4px solid #e5e3de;padding:1rem 1.1rem;margin-bottom:.7rem}
  .brudd-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.5rem;gap:.5rem;flex-wrap:wrap}
  .regel-id{font-size:.8rem;margin:0 .4rem;color:#2b3285;font-family:ui-monospace,monospace}
  .regel-desc{font-size:.84rem;color:#374151}
  .brudd-teller{font-size:.72rem;color:#9ca3af;white-space:nowrap;flex-shrink:0}
  .brudd-hjelp{font-size:.82rem;color:#555;margin:.6rem 0;padding:.5rem .8rem;background:#f4ecdf;border-left:3px solid #b8860b}
  .node-info{background:#f1f0ee;padding:.5rem .7rem;margin:.4rem 0;font-size:.8rem}
  .node-selector{display:block;color:#2b3285;font-family:ui-monospace,monospace;margin-bottom:.2rem;word-break:break-all;font-size:.78rem}
  .failure-summary{color:#6b7280;font-size:.77rem;margin-top:.2rem;white-space:pre-wrap}

  /* Screenshots */
  .skjermdump-gruppe{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:.9rem}
  .skjermdump-wrapper{background:#f1f0ee;padding:.7rem}
  .skjermdump-label{font-size:.68rem;color:#6b7280;margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}
  .skjermdump{width:100%;border:1px solid #e5e3de;cursor:zoom-in;transition:box-shadow .2s;display:block}
  .skjermdump:hover{box-shadow:0 4px 16px rgba(10,19,85,.15)}
  .nærbilde{max-height:200px;object-fit:contain;background:white}
  .helside{max-height:300px;object-fit:cover;object-position:top}

  /* Artifact grid */
  .artefakt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem;margin-top:1.2rem}
  .artefakt-kort{background:#faf6f0;border:1px solid #f1f0ee;padding:1.2rem 1.4rem}
  .artefakt-kort h3{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;margin-bottom:.9rem}

  /* Tables */
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{background:#f4ecdf;text-align:left;padding:.5rem .7rem;font-weight:600;color:#0a1355;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.45rem .7rem;border-bottom:1px solid #f1f0ee;vertical-align:top}

  /* Badges */
  .badge{display:inline-block;padding:.15rem .6rem;border-radius:100px;font-size:.7rem;font-weight:600}
  .badge.critical{background:#fee2e2;color:#c53030}
  .badge.serious{background:#fde8d4;color:#9a3412}
  .badge.moderate{background:#f3dda2;color:#713f12}
  .badge.minor{background:#f1f0ee;color:#4b5563}
  .badge.dead{background:#f1f0ee;color:#4b5563}

  /* Misc */
  .overskrift-liste{list-style:none;font-size:.82rem}
  .overskrift-liste li{padding:.25rem 0}
  .h-badge{display:inline-block;width:26px;font-size:.7rem;font-weight:700;color:#2b3285}
  .mangler{color:#c53030;font-weight:600}
  .ok-tekst{color:#07604f;font-size:.9rem}
  .ingen{color:#9ca3af;font-style:italic;font-size:.84rem}
  .wcag-ok{background:#ecfdf5;color:#064e3b;padding:.8rem 1rem;border-left:3px solid #07604f;font-size:.88rem}
  footer{text-align:center;padding:2.5rem;color:#9ca3af;font-size:.78rem;border-top:1px solid #f1f0ee;margin-top:2rem}
</style>
</head>
<body>
<nav class="sidemeny">
  <div class="sidemeny-header">
    <div class="sidemeny-logo">KS Tilskudd · UU-tester</div>
    <div class="env-badge">PRODUKSJON${versjon ? ` · ${versjon}` : ''}</div>
    <h1>Tilgjengelighetsrapport <span>${dato} ${tidspunkt} · ${totalt.sider} sider</span></h1>
  </div>
  <ul>${sidenavigasjon}</ul>
</nav>
<div class="hoveddel">
  <div class="rapport-header">
    <div>
      <h1>Tilgjengelighetsrapport</h1>
      <div class="meta"><a href="${url}" target="_blank">${url}</a> · ${dato} ${tidspunkt} · ${totalt.sider} sider testet${nettleser ? ` · Chromium ${nettleser.split('.')[0]}` : ''}</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp aktiv">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
      <a href="#tastatur" class="knapp sekundær">Tastaturtest ↓</a>
    </div>
  </div>
  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er UU-testing?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      UU-testing (universell utforming) kontrollerer at applikasjonen er tilgjengelig for alle brukere,
      inkludert de med nedsatt syn, motorikk eller kognisjon. Testen kjøres automatisk daglig mot
      alle undersider og rapporterer brudd mot WCAG 2.1 A/AA-standarden.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva testes</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>♿ WCAG 2.1 A/AA-regler (axe-core)</li>
          <li>🔘 Knapper med manglende label</li>
          <li>🖼️ Bilder uten alt-tekst</li>
          <li>📝 Skjemafelt uten label</li>
          <li>🔗 Døde og ødelagte lenker</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva måles</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Antall WCAG-brudd per side</li>
          <li>Alvorlighetsgrad (kritisk → lav)</li>
          <li>HTTP-status på alle lenker</li>
          <li>Sidestruktur og landmarks</li>
          <li>Overskriftshierarki (H1–H6)</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Verktøy og metode</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>axe-core (WCAG-motor)</li>
          <li>Playwright (ekte nettleser)</li>
          <li>Skjermdumper av feilende elementer</li>
          <li>Opptil 20 undersider per kjøring</li>
          <li>Kjøres daglig kl. 08:30</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="score-kort">
    <div class="score-sirkel ${scoreKlasse}">${s}</div>
    <div class="score-tekst"><strong>UU-score</strong><p>Basert på WCAG-brudd, døde lenker og manglende labels på tvers av ${totalt.sider} sider. Klikk på skjermdumper for å forstørre.</p></div>
  </div>

  <div class="kort-grid">
    <div class="kort ${totalt.sider > 0 ? 'ok' : 'advarsel'}"><div class="tall">${totalt.sider}</div><div class="etikett">Sider testet</div></div>
    <div class="kort ${totalt.wcagBrudd === 0 ? 'ok' : totalt.wcagBrudd < 5 ? 'advarsel' : 'kritisk'}"><div class="tall">${totalt.wcagBrudd}</div><div class="etikett">WCAG-brudd</div><div class="undertekst">${totalt.kritiske} kritiske · ${totalt.alvorlige} alvorlige</div></div>
    <div class="kort ${totalt.dødelenker === 0 ? 'ok' : 'kritisk'}"><div class="tall">${totalt.dødelenker}</div><div class="etikett">Døde lenker</div></div>
    <div class="kort ${totalt.knappUtenLabel === 0 ? 'ok' : 'advarsel'}"><div class="tall">${totalt.knapper}</div><div class="etikett">Knapper testet</div><div class="undertekst">${totalt.knappUtenLabel} uten label</div></div>
    <div class="kort ${totalt.bilderUtenAlt === 0 ? 'ok' : 'advarsel'}"><div class="tall">${totalt.bilder}</div><div class="etikett">Bilder testet</div><div class="undertekst">${totalt.bilderUtenAlt} uten alt</div></div>
    <div class="kort ${totalt.feltUtenLabel === 0 ? 'ok' : 'advarsel'}"><div class="tall">${totalt.skjemafelt}</div><div class="etikett">Skjemafelt</div><div class="undertekst">${totalt.feltUtenLabel} uten label</div></div>
  </div>
  ${sideDetaljer}
  <div class="seksjon" id="tastatur" style="margin-top:2rem">
    <div class="seksjon-tittel">⌨️ Tastaturnavigasjon (WCAG 2.1 A/AA)</div>
    <p style="font-size:.83rem;color:#374151;line-height:1.6;margin-bottom:1rem">
      Automatisk sjekk av om siden kan betjenes fullt ut med kun tastatur.
      Dekker WCAG 2.1.1, 2.1.2, 2.4.1, 2.4.3 og 2.4.7.
    </p>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem;font-size:.82rem">
      <span style="background:#ecfdf5;color:#07604f;padding:.2rem .7rem;border-radius:100px;font-weight:600">✅ ${tastatur.bestått} bestått</span>
      ${tastatur.advarsel > 0 ? `<span style="background:#f3dda2;color:#713f12;padding:.2rem .7rem;border-radius:100px;font-weight:600">⚠️ ${tastatur.advarsel} advarsler</span>` : ''}
      ${tastatur.feil > 0 ? `<span style="background:#fee2e2;color:#c53030;padding:.2rem .7rem;border-radius:100px;font-weight:600">❌ ${tastatur.feil} feil</span>` : ''}
    </div>
    <table>
      <thead><tr><th>WCAG</th><th>Test</th><th>Resultat</th><th>Detalj</th></tr></thead>
      <tbody>
        ${tastatur.tester.map(t => `
        <tr>
          <td><code style="font-size:.75rem;color:#2b3285">${t.wcag}</code></td>
          <td style="font-size:.83rem">${t.navn}</td>
          <td><span style="display:inline-block;padding:.1rem .55rem;border-radius:100px;font-size:.7rem;font-weight:600;background:${t.resultat === 'bestått' ? '#ecfdf5' : t.resultat === 'feil' ? '#fee2e2' : '#f3dda2'};color:${t.resultat === 'bestått' ? '#07604f' : t.resultat === 'feil' ? '#c53030' : '#713f12'}">${t.resultat === 'bestått' ? '✅ bestått' : t.resultat === 'feil' ? '❌ feil' : '⚠️ advarsel'}</span></td>
          <td style="font-size:.78rem;color:#6b7280">${t.detalj || '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="seksjon" style="margin-top:2rem">
    <div class="seksjon-tittel">Slik beregnes UU-scoren</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">Kritisk WCAG-brudd</span><span style="color:#c53030;font-weight:700">× 15 poeng</span>
      <span style="color:#374151">Alvorlig WCAG-brudd</span><span style="color:#9a3412;font-weight:700">× 8 poeng</span>
      <span style="color:#374151">Moderat WCAG-brudd</span><span style="color:#713f12;font-weight:700">× 3 poeng</span>
      <span style="color:#374151">Mindre WCAG-brudd</span><span style="color:#6b7280;font-weight:700">× 1 poeng</span>
      <span style="color:#374151">Død lenke</span><span style="color:#c53030;font-weight:700">× 5 poeng</span>
      <span style="color:#374151">Knapp uten label</span><span style="color:#9a3412;font-weight:700">× 4 poeng</span>
      <span style="color:#374151">Bilde uten alt-tekst</span><span style="color:#9a3412;font-weight:700">× 4 poeng</span>
      <span style="color:#374151">Skjemafelt uten label</span><span style="color:#9a3412;font-weight:700">× 4 poeng</span>
      <span style="color:#374151">Tastatur-feil (WCAG-brudd)</span><span style="color:#c53030;font-weight:700">× 15 poeng</span>
      <span style="color:#374151">Tastatur-advarsel</span><span style="color:#9a3412;font-weight:700">× 5 poeng</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Score = maks(0, 100 − sum av trekk) &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>
  <footer>KS Tilskudd · UU-tester · axe-core + Playwright · ${dato} ${tidspunkt}</footer>
</div>
</body>
</html>`;
}
