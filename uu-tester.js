import { chromium, firefox, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { START_URL, MAX_SIDER, VIEWPORT, SIDE_TIMEOUT, IDLE_TIMEOUT, LAST_TIMEOUT, LINK_TIMEOUT, RAPPORTDIR, GITHUB_PAGES_AUTH, FIREFOX_KRYSSSJEKK, WEBKIT_KRYSSSJEKK } from './config.js';
import { hentVersjon } from './lib/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = RAPPORTDIR ? path.join(RAPPORTDIR, dato) : path.join(__dirname, 'rapporter', dato);
const skjermDir = path.join(rapportDir, 'skjermbilder');
fs.mkdirSync(skjermDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;

console.log(`\n🔍 Starter UU-analyse av: ${START_URL}`);
console.log(`📅 Dato: ${dato}`);
console.log(`📄 Maks antall sider: ${MAX_SIDER}\n`);

const authFile = path.join(__dirname, 'prod-auth.json');
const harAuth = fs.existsSync(authFile);
if (harAuth) console.log('🔐 Bruker lagret PROD-innlogging (prod-auth.json)');
else console.log('ℹ️  Kjører uten innlogging (kjør npm run login-prod for å logge inn)');

const browser = await chromium.launch();
const nettleser = browser.version();
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 UU-Tester/1.0',
  viewport: VIEWPORT,
  ...(harAuth ? { storageState: authFile } : {})
});

if (GITHUB_PAGES_AUTH) await context.addInitScript(() => sessionStorage.setItem('ks-auth', '1'));

const versjon = await hentVersjon(context, START_URL);

const testdata = {
  bruker: harAuth ? 'prod-auth.json (lagret sesjon)' : 'ikke innlogget',
  modus: harAuth ? 'lagret sesjon' : 'anonym',
  viewport: `${VIEWPORT.width}×${VIEWPORT.height}`,
  startUrl: START_URL,
};

const besøkte = new Set();
const kø = [START_URL];
const oppdagetFraMap = new Map();
oppdagetFraMap.set(START_URL.replace(/\/$/, '') || START_URL, null);
const sideResultater = [];
let sideIndeks = 0;

// --- Ta skjermdump av et feilende element ---
async function taSkjermdump(page, selectors, filnavn, farge = '#dc3545', dir = skjermDir) {
  const relPrefix = path.basename(dir);
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
      const el = page.locator(selectors[0]).first();
      if (await el.count() > 0) {
        const boks = await el.boundingBox();
        if (boks && boks.width > 0 && boks.height > 0) {
          const nærFil = path.join(dir, `${filnavn}-element.png`);
          await page.screenshot({
            path: nærFil,
            clip: {
              x: Math.max(0, boks.x - 20),
              y: Math.max(0, boks.y - 20),
              width: Math.min(boks.width + 40, 1280),
              height: Math.min(boks.height + 40, 600)
            }
          });
          nærbilde = `${relPrefix}/${filnavn}-element.png`;
        }
      }
    } catch {}

    // Ta helsidebilde med kontekst
    const helFil = path.join(dir, `${filnavn}-side.png`);
    await page.screenshot({ path: helFil, fullPage: false });
    const helside = `${relPrefix}/${filnavn}-side.png`;

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

async function analyserSide(url, indeks, oppdagetFra = null, ctx = context, tarScreenshots = true, skjermDirParam = skjermDir) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: LAST_TIMEOUT });

    const tittel = await page.title();

    // Hent org.nr. hvis det vises på siden (f.eks. på søknadssider)
    const orgnr = await page.evaluate(() => {
      const tekst = document.body.innerText;
      const m = tekst.match(/org(?:anisasjon)?(?:snummer)?[.:\s]*(\d{3}[\s]?\d{3}[\s]?\d{3})/i);
      return m ? m[1].replace(/\s/g, '') : null;
    }).catch(() => null);

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
    const violasjonerMedBilder = [];
    if (tarScreenshots) {
      console.log(`  📸 Tar skjermdumper av ${axe.violations.length} brudd...`);
    }
    for (let vi = 0; vi < axe.violations.length; vi++) {
      const v = axe.violations[vi];
      if (!tarScreenshots) {
        violasjonerMedBilder.push({ ...v, bilder: { nærbilde: null, helside: null } });
        continue;
      }
      const selectors = v.nodes.flatMap(n => n.target).slice(0, 5);
      const filnavn = `s${indeks}-${v.id.replace(/[^a-z0-9]/gi, '-')}-${vi}`;
      const farge = v.impact === 'critical' ? '#dc3545' : v.impact === 'serious' ? '#fd7e14' : '#ffc107';
      const bilder = await taSkjermdump(page, selectors, filnavn, farge, skjermDirParam);
      violasjonerMedBilder.push({ ...v, bilder });
    }

    // Finn interne lenker
    const aLenkerLoc = page.locator('a[href]');
    const aLenkerCount = await aLenkerLoc.count();
    const internelenker = [];
    for (let li = 0; li < aLenkerCount; li++) {
      const href = await aLenkerLoc.nth(li).getAttribute('href') ?? '';
      const fullHref = href.startsWith('http') ? href : (href.startsWith('/') ? baseOrigin + href : '');
      if (fullHref.startsWith(baseOrigin) && !fullHref.includes('#') && !fullHref.includes('/authorize/')) {
        internelenker.push(fullHref.split('?')[0].replace(/\/$/, '') || '/');
      }
    }

    // Lenkesjekk
    const allelenker = [];
    for (let li = 0; li < aLenkerCount; li++) {
      const a = aLenkerLoc.nth(li);
      const href = await a.getAttribute('href') ?? '';
      const fullHref = href.startsWith('http') ? href : (href.startsWith('/') ? baseOrigin + href : href);
      const innerTekst = (await a.innerText().catch(() => '')).trim();
      const ariaLabel = await a.getAttribute('aria-label') ?? '';
      const tekst = innerTekst || ariaLabel || '(ingen tekst)';
      const harTekst = !!(innerTekst || ariaLabel);
      allelenker.push({
        tekst,
        href: fullHref,
        intern: fullHref.startsWith(baseOrigin),
        harTekst
      });
    }

    const lenkeSjekk = await Promise.all(
      allelenker.map(async (l) => {
        if (!l.href || l.href.startsWith('mailto:') || l.href.startsWith('tel:') || l.href.startsWith('javascript:') || l.href.includes('/authorize/')) {
          return { ...l, status: 'skip', ok: true };
        }
        // Personvernerklæring og Tilgjengelighetserklæring er ikke implementert ennå – hopp over når href er plassholder
        if (/personvern(?:erklæring)?|tilgjengelighet(?:serklæring)?/i.test(l.tekst) &&
            (l.href === '#' || l.href.startsWith('#') || l.href === '')) {
          return { ...l, status: 'skip', ok: true };
        }
        try {
          const r = await fetch(l.href, { method: 'HEAD', signal: AbortSignal.timeout(LINK_TIMEOUT) });
          return { ...l, status: r.status, ok: r.ok };
        } catch {
          try {
            const r = await fetch(l.href, { method: 'GET', signal: AbortSignal.timeout(LINK_TIMEOUT) });
            return { ...l, status: r.status, ok: r.ok };
          } catch {
            return { ...l, status: 'feil', ok: false };
          }
        }
      })
    );

    // Skjermdump av sider med døde lenker
    const dødeLenker = lenkeSjekk.filter(l => !l.ok && l.status !== 'skip');
    if (dødeLenker.length > 0 && tarScreenshots) {
      const dødFil = `s${indeks}-doede-lenker`;
      const dødSelectors = dødeLenker.map(l => `a[href="${l.href}"]`).slice(0, 5);
      const dødBilder = await taSkjermdump(page, dødSelectors, dødFil, '#6c757d', skjermDirParam);
      dødeLenker.forEach(l => { l.bilder = dødBilder; });
    }

    // Knapper
    const knapperLoc = page.locator('button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"]');
    const knapperCount = await knapperLoc.count();
    const knapper = [];
    for (let ki = 0; ki < knapperCount; ki++) {
      const el = knapperLoc.nth(ki);
      const tag = (await el.evaluate(n => n.tagName.toLowerCase()));
      const type = await el.getAttribute('type') ?? '';
      const innerTekst = (await el.innerText().catch(() => '')).trim();
      const value = await el.getAttribute('value') ?? '';
      const ariaLabel = await el.getAttribute('aria-label') ?? '';
      const title = await el.getAttribute('title') ?? '';
      const tekst = innerTekst || value || ariaLabel || title;
      const harLabel = !!(innerTekst || ariaLabel || title || value);
      const disabled = await el.isDisabled().catch(() => false);
      knapper.push({ tag, type, tekst, harLabel, disabled });
    }

    // Bilder
    const bilderLoc = page.locator('img');
    const bilderCount = await bilderLoc.count();
    const bilder = [];
    for (let bi = 0; bi < bilderCount; bi++) {
      const img = bilderLoc.nth(bi);
      const fullSrc = await img.getAttribute('src') ?? '';
      const alt = await img.getAttribute('alt');
      const rolle = await img.getAttribute('role') ?? '';
      const { naturalWidth, naturalHeight } = await img.evaluate(n => ({ naturalWidth: n.naturalWidth, naturalHeight: n.naturalHeight }));
      bilder.push({
        src: fullSrc.split('/').pop() || fullSrc,
        fullSrc,
        alt: alt ?? null,
        harAlt: alt !== null,
        altErTom: alt === '',
        rolle,
        bredde: naturalWidth,
        høyde: naturalHeight
      });
    }

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
      oppdagetFra,
      orgnr,
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const utenFokus = [];
    let forrigeKey = null;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const interaktiveDOM = await page.locator('a[href]:not([tabindex="-1"]),button:not([tabindex="-1"]):not([disabled]),input:not([type=hidden]):not([tabindex="-1"])').count();
    const nådd = new Set();
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    let forrigeId = null, konsekutive = 0, felle = null;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    await page.evaluate(() => document.body.focus());
    await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const utgangsUrl = page.url();
    let aktivert = false;
    for (let i = 0; i < 15 && !aktivert; i++) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});
      const erNavLenke = await page.evaluate(() => {
        const el = document.activeElement;
        if (el?.tagName !== 'A') return false;
        const href = el.getAttribute('href') || '';
        return href.length > 0 && !href.startsWith('#') && !href.startsWith('javascript') && !href.startsWith('mailto');
      });
      if (erNavLenke) {
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
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

// ── Reflow-test (WCAG 1.4.10) ────────────────────────────────────────────────

async function kjørReflowSjekk(ctx, url) {
  console.log('\n📱 Kjører Reflow-sjekk (WCAG 1.4.10)...');
  const tester = [];
  const page = await ctx.newPage();

  function add(kategori, wcag, navn, resultat, detalj = '') {
    tester.push({ kategori, wcag, navn, resultat, detalj });
    const ikon = { bestått: '✅', feil: '❌', advarsel: '⚠️' }[resultat] || '⚪';
    console.log(`  ${ikon} [${wcag}] ${navn}${detalj ? ` – ${detalj}` : ''}`);
  }

  try {
    // 320px tilsvarer 400 % zoom på 1280px-skjerm
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});

    // Horisontal rulling
    const horisontalScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    if (horisontalScroll) {
      const overflows = await page.evaluate(() => {
        const funnet = [];
        document.querySelectorAll('*').forEach(el => {
          if (el.getBoundingClientRect().right > window.innerWidth + 5) {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const cls = el.className && typeof el.className === 'string'
              ? `.${el.className.trim().split(/\s+/)[0]}` : '';
            funnet.push(`${tag}${id || cls}`);
          }
        });
        return [...new Set(funnet)].slice(0, 5);
      });
      add('reflow', '1.4.10', 'Ingen horisontal rulling ved 320px (400 % zoom)', 'feil',
        `Horisontal rulling nødvendig. Elementer: ${overflows.join(', ')}`);
    } else {
      add('reflow', '1.4.10', 'Ingen horisontal rulling ved 320px (400 % zoom)', 'bestått',
        'Ingen horisontal rulling ved 320px bredde');
    }

    // Avskåret innhold
    const klippet = await page.evaluate(() => {
      const funnet = [];
      document.querySelectorAll('*').forEach(el => {
        const st = window.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        if (['html', 'body', 'script', 'style', 'noscript'].includes(tag)) return;
        if ((st.overflow === 'hidden' || st.overflowX === 'hidden') &&
            el.scrollWidth > el.clientWidth + 4 &&
            el.textContent.trim().length > 10) {
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? `.${el.className.trim().split(/\s+/)[0]}` : '';
          funnet.push(`${tag}${id || cls}`);
        }
      });
      return [...new Set(funnet)].slice(0, 5);
    });
    if (klippet.length > 0) {
      add('klipping', '1.4.10', 'Innhold ikke avskåret ved 320px', 'advarsel',
        `Mulig avskåret innhold: ${klippet.join(', ')}`);
    } else {
      add('klipping', '1.4.10', 'Innhold ikke avskåret ved 320px', 'bestått');
    }

  } catch (e) {
    console.log(`  ⚠️  Reflow-sjekk feilet: ${e.message.slice(0, 80)}`);
  } finally {
    await page.close();
  }

  const bestått = tester.filter(t => t.resultat === 'bestått').length;
  const feil    = tester.filter(t => t.resultat === 'feil').length;
  const advarsel = tester.filter(t => t.resultat === 'advarsel').length;
  return { tester, bestått, feil, advarsel };
}

// ── Tekstmellomrom-test (WCAG 1.4.12) ────────────────────────────────────────

async function kjørTekstmellomromSjekk(ctx, url) {
  console.log('\n📐 Kjører tekstmellomrom-sjekk (WCAG 1.4.12)...');
  const tester = [];
  const page = await ctx.newPage();

  function add(kategori, wcag, navn, resultat, detalj = '') {
    tester.push({ kategori, wcag, navn, resultat, detalj });
    const ikon = { bestått: '✅', feil: '❌', advarsel: '⚠️' }[resultat] || '⚪';
    console.log(`  ${ikon} [${wcag}] ${navn}${detalj ? ` – ${detalj}` : ''}`);
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Injiser WCAG 1.4.12-stilregler
    await page.addStyleTag({ content: `
      * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p  { margin-bottom: 2em !important; }
    ` });
    await page.waitForFunction(() => document.readyState === 'complete').catch(() => {});

    // Sjekk for klipping (overflow:hidden + scrollHeight > clientHeight)
    const klippet = await page.evaluate(() => {
      const funnet = [];
      document.querySelectorAll('*').forEach(el => {
        const st = window.getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        if (['html', 'body', 'script', 'style', 'noscript'].includes(tag)) return;
        if ((st.overflow === 'hidden' || st.overflowY === 'hidden') &&
            el.scrollHeight > el.clientHeight + 4 &&
            el.textContent.trim().length > 10) {
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? `.${el.className.trim().split(/\s+/)[0]}` : '';
          funnet.push(`${tag}${id || cls}`);
        }
      });
      return [...new Set(funnet)].slice(0, 5);
    });
    if (klippet.length > 0) {
      add('klipping', '1.4.12', 'Ingen tekstklipping ved økt linjehøyde og bokstavmellomrom', 'advarsel',
        `Mulig avskåret tekst etter stilinjeksjon: ${klippet.join(', ')}`);
    } else {
      add('klipping', '1.4.12', 'Ingen tekstklipping ved økt linjehøyde og bokstavmellomrom', 'bestått');
    }

    // Sjekk for horisontal overflyt etter stilinjeksjon
    const horisontalOverflyt = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 10
    );
    if (horisontalOverflyt) {
      add('overflyt', '1.4.12', 'Ingen horisontal overflyt etter økt tekstmellomrom', 'advarsel',
        'Horisontal rulling observert etter injeksjon av WCAG 1.4.12-stiler');
    } else {
      add('overflyt', '1.4.12', 'Ingen horisontal overflyt etter økt tekstmellomrom', 'bestått');
    }

  } catch (e) {
    console.log(`  ⚠️  Tekstmellomrom-sjekk feilet: ${e.message.slice(0, 80)}`);
  } finally {
    await page.close();
  }

  const bestått = tester.filter(t => t.resultat === 'bestått').length;
  const feil    = tester.filter(t => t.resultat === 'feil').length;
  const advarsel = tester.filter(t => t.resultat === 'advarsel').length;
  return { tester, bestått, feil, advarsel };
}

// ── Ekstra WCAG-sjekker (1.3.4, 1.4.13, 3.2.1, 3.2.2, 3.3.1) ──────────────

async function kjørEkstraWcagSjekker(ctx, url) {
  console.log('\n🔎 Kjører ekstra WCAG-sjekker...');
  const tester = [];
  const page = await ctx.newPage();

  function add(kategori, wcag, navn, resultat, detalj = '') {
    tester.push({ kategori, wcag, navn, resultat, detalj });
    const ikon = { bestått: '✅', feil: '❌', advarsel: '⚠️' }[resultat] || '⚪';
    console.log(`  ${ikon} [${wcag}] ${navn}${detalj ? ` – ${detalj}` : ''}`);
  }

  try {
    // 1.3.4 Orientering
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const portraitScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 5
    );
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const landscapeScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 5
    );
    if (portraitScroll || landscapeScroll) {
      add('orientering', '1.3.4', 'Innhold tilgjengelig i begge orienteringer', 'advarsel',
        `Horisontal rulling ved ${[portraitScroll && 'portrett', landscapeScroll && 'landskap'].filter(Boolean).join(' og ')}`);
    } else {
      add('orientering', '1.3.4', 'Innhold tilgjengelig i begge orienteringer', 'bestått');
    }

    // 1.4.13 Innhold ved pek eller fokus
    await page.setViewportSize(VIEWPORT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const tooltipKandidater = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[title]:not(iframe):not(link):not(meta):not(script)'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => ({
          selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
          verdi: (el.getAttribute('title') || '').slice(0, 50)
        })).slice(0, 5)
    );
    if (tooltipKandidater.length === 0) {
      add('hover-fokus', '1.4.13', 'Innhold ved pek eller fokus', 'bestått', 'Ingen tooltip-elementer (title-attributt) funnet');
    } else {
      for (const k of tooltipKandidater.slice(0, 2)) {
        try {
          await page.locator(k.selector).first().hover({ timeout: 2000 });
          await page.keyboard.press('Escape');
        } catch {}
      }
      add('hover-fokus', '1.4.13', 'Innhold ved pek eller fokus', 'advarsel',
        `${tooltipKandidater.length} tooltip-element(er) med title-attributt – krever manuell verifisering av hover-atferd og Escape-avvisning`);
    }

    // 3.2.1 Fokus (uventet kontekstendring)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const urlFør321 = page.url();
    let uventetNavigasjon321 = false;
    for (let i = 0; i < 15 && !uventetNavigasjon321; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);
      const nåUrl = page.url();
      if (nåUrl !== urlFør321 && !nåUrl.includes('/authorize/') && !nåUrl.includes('idporten')) {
        uventetNavigasjon321 = true;
      }
    }
    if (uventetNavigasjon321) {
      add('fokus-kontekst', '3.2.1', 'Fokus utløser ikke uventet kontekstendring', 'feil',
        `Uventet navigasjon ved Tab: ${page.url()}`);
    } else {
      add('fokus-kontekst', '3.2.1', 'Fokus utløser ikke uventet kontekstendring', 'bestått');
    }

    // 3.2.2 Inndata (uventet kontekstendring ved select-endring)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const urlFør322 = page.url();
    const antallSelect = await page.locator('select').count();
    let uventetNavigasjon322 = false;
    if (antallSelect > 0) {
      const sel = page.locator('select').first();
      const antallOptions = await sel.locator('option').count();
      if (antallOptions > 1) {
        await sel.selectOption({ index: 1 });
        await page.waitForTimeout(500);
        const nåUrl = page.url();
        if (nåUrl !== urlFør322 && !nåUrl.includes('/authorize/')) uventetNavigasjon322 = true;
      }
    }
    if (uventetNavigasjon322) {
      add('inndata-kontekst', '3.2.2', 'Inndata utløser ikke uventet kontekstendring', 'feil',
        'Navigasjon utløst av select-endring uten brukerbekreftelse');
    } else {
      add('inndata-kontekst', '3.2.2', 'Inndata utløser ikke uventet kontekstendring', 'bestått',
        antallSelect > 0 ? `${antallSelect} select-element(er) sjekket` : 'Ingen select-elementer funnet');
    }

    // 3.3.1 Feilidentifikasjon (aria-invalid ved ugyldig input)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const skjemaInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll('form')).map(form => ({
        harPåkrevde: form.querySelectorAll('[required],[aria-required="true"]').length > 0,
        antall: form.querySelectorAll('[required],[aria-required="true"]').length
      }))
    );
    const skjemaMedPåkrevde = skjemaInfo.filter(s => s.harPåkrevde);
    if (skjemaMedPåkrevde.length === 0) {
      add('feilidentifikasjon', '3.3.1', 'Feilidentifikasjon – aria-invalid ved ugyldig input', 'bestått',
        'Ingen skjema med påkrevde felt på forsiden');
    } else {
      const submitBtn = page.locator('button[type="submit"],input[type="submit"]').first();
      if (await submitBtn.count() > 0) {
        await submitBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);
        const ariaInvalid = await page.locator('[aria-invalid="true"]').count();
        const liveRegioner = await page.locator('[role="alert"],[aria-live="assertive"],[aria-live="polite"]').count();
        if (ariaInvalid > 0) {
          add('feilidentifikasjon', '3.3.1', 'Feilidentifikasjon – aria-invalid ved ugyldig input', 'bestått',
            `${ariaInvalid} felt med aria-invalid="true" etter tom innsending`);
        } else if (liveRegioner > 0) {
          add('feilidentifikasjon', '3.3.1', 'Feilidentifikasjon – aria-invalid ved ugyldig input', 'advarsel',
            `Feilmeldinger vises (${liveRegioner} live-region(er)), men ingen aria-invalid på feltene`);
        } else {
          add('feilidentifikasjon', '3.3.1', 'Feilidentifikasjon – aria-invalid ved ugyldig input', 'advarsel',
            'Påkrevde felt funnet, men ingen aria-invalid eller live-regions etter tom innsending');
        }
      } else {
        add('feilidentifikasjon', '3.3.1', 'Feilidentifikasjon – aria-invalid ved ugyldig input', 'bestått',
          `${skjemaMedPåkrevde[0].antall} påkrevde felt funnet, ingen synlig submit-knapp`);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Ekstra WCAG-sjekk feilet: ${e.message.slice(0, 80)}`);
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
  const resultat = await analyserSide(normUrl, sideIndeks, oppdagetFraMap.get(normUrl) ?? null);
  if (resultat) {
    sideResultater.push(resultat);
    for (const lenke of resultat.internelenker) {
      const norm = lenke.replace(/\/$/, '');
      if (!besøkte.has(norm) && !kø.includes(norm)) {
        kø.push(norm);
        if (!oppdagetFraMap.has(norm)) oppdagetFraMap.set(norm, normUrl);
      }
    }
  }
}

const tastatur = await kjørTastaturSjekker(context, START_URL);
const reflow = await kjørReflowSjekk(context, START_URL);
const tekstmellomrom = await kjørTekstmellomromSjekk(context, START_URL);
const ekstraWcag = await kjørEkstraWcagSjekker(context, START_URL);

await browser.close();

function beregnTotaltFraRun(sr, ta, re, te, ek) {
  const alleVIds = sr.flatMap(s => (s.wcag?.detaljer ?? []).map(v => ({ id: v.id, impact: v.impact })));
  return {
    sider: sr.length,
    wcagBrudd: sr.reduce((s, r) => s + r.wcag.brudd, 0),
    kritiske: sr.reduce((s, r) => s + r.wcag.kritiske, 0),
    alvorlige: sr.reduce((s, r) => s + r.wcag.alvorlige, 0),
    moderate: sr.reduce((s, r) => s + r.wcag.moderate, 0),
    mindre: sr.reduce((s, r) => s + r.wcag.mindre, 0),
    uniqKritiske: new Set(alleVIds.filter(v => v.impact === 'critical').map(v => v.id)).size,
    uniqAlvorlige: new Set(alleVIds.filter(v => v.impact === 'serious').map(v => v.id)).size,
    uniqModerate: new Set(alleVIds.filter(v => v.impact === 'moderate').map(v => v.id)).size,
    uniqMindre: new Set(alleVIds.filter(v => v.impact === 'minor').map(v => v.id)).size,
    dødelenker: sr.reduce((s, r) => s + r.lenker.døde.length, 0),
    knapper: sr.reduce((s, r) => s + r.knapper.length, 0),
    knappUtenLabel: sr.reduce((s, r) => s + r.knapper.filter(k => !k.harLabel).length, 0),
    bilder: sr.reduce((s, r) => s + r.bilder.length, 0),
    bilderUtenAlt: sr.reduce((s, r) => s + r.bilder.filter(b => !b.harAlt).length, 0),
    skjemafelt: sr.reduce((s, r) => s + r.skjemafelt.length, 0),
    feltUtenLabel: sr.reduce((s, r) => s + r.skjemafelt.filter(f => !f.harLabel).length, 0),
    tastaturFeil: ta.feil, tastaturAdvarsel: ta.advarsel,
    reflowFeil: re.feil, reflowAdvarsel: re.advarsel,
    tekstmellomromFeil: te.feil, tekstmellomromAdvarsel: te.advarsel,
    ekstraFeil: ek.feil, ekstraAdvarsel: ek.advarsel,
  };
}

let firefoxRun = null;
if (FIREFOX_KRYSSSJEKK) {
  console.log('\n🦊 Kjører Firefox full test...');
  try {
    const ffBrowser = await firefox.launch();
    const ffCtx = await ffBrowser.newContext({
      userAgent: 'Mozilla/5.0 UU-Tester/1.0 Firefox',
      viewport: VIEWPORT,
      ...(harAuth ? { storageState: authFile } : {})
    });
    if (GITHUB_PAGES_AUTH) await ffCtx.addInitScript(() => sessionStorage.setItem('ks-auth', '1'));

    const ffBesøkte = new Set();
    const ffKø = [START_URL];
    const ffOppdagetFraMap = new Map();
    ffOppdagetFraMap.set(START_URL.replace(/\/$/, '') || START_URL, null);
    const ffSider = [];
    let ffSideIndeks = 0;

    while (ffKø.length > 0 && ffBesøkte.size < MAX_SIDER) {
      const ffUrl = ffKø.shift();
      const ffNorm = ffUrl.replace(/\/$/, '') || START_URL;
      if (ffBesøkte.has(ffNorm)) continue;
      ffBesøkte.add(ffNorm);
      ffSideIndeks++;
      console.log(`  🦊 [${ffBesøkte.size}/${MAX_SIDER}] Analyserer: ${ffNorm}`);
      const res = await analyserSide(ffNorm, ffSideIndeks, ffOppdagetFraMap.get(ffNorm) ?? null, ffCtx, false, skjermDir);
      if (res) {
        ffSider.push(res);
        for (const lenke of res.internelenker) {
          const norm = lenke.replace(/\/$/, '');
          if (!ffBesøkte.has(norm) && !ffKø.includes(norm)) {
            ffKø.push(norm);
            if (!ffOppdagetFraMap.has(norm)) ffOppdagetFraMap.set(norm, ffNorm);
          }
        }
      }
    }

    const ffTastatur = await kjørTastaturSjekker(ffCtx, START_URL);
    const ffReflow = await kjørReflowSjekk(ffCtx, START_URL);
    const ffTekstmellomrom = await kjørTekstmellomromSjekk(ffCtx, START_URL);
    const ffEkstraWcag = await kjørEkstraWcagSjekker(ffCtx, START_URL);
    await ffBrowser.close();

    const ffTotalt = beregnTotaltFraRun(ffSider, ffTastatur, ffReflow, ffTekstmellomrom, ffEkstraWcag);
    firefoxRun = {
      fast: { bruker: testdata.bruker, sider: ffSider, tastatur: ffTastatur, reflow: ffReflow, tekstmellomrom: ffTekstmellomrom, ekstraWcag: ffEkstraWcag, totalt: ffTotalt },
      tilfeldig: null
    };
    console.log(`🦊 Firefox: ${ffTotalt.sider} sider · ${ffTotalt.wcagBrudd} WCAG-brudd`);
  } catch (e) {
    console.log(`⚠️  Firefox-test feilet: ${e.message.slice(0, 80)}`);
  }
}

let webkitRun = null;
if (WEBKIT_KRYSSSJEKK) {
  console.log('\n🧭 Kjører WebKit (Safari) full test...');
  try {
    const wkBrowser = await webkit.launch();
    const wkCtx = await wkBrowser.newContext({
      userAgent: 'Mozilla/5.0 UU-Tester/1.0 WebKit',
      viewport: VIEWPORT,
      ...(harAuth ? { storageState: authFile } : {})
    });
    if (GITHUB_PAGES_AUTH) await wkCtx.addInitScript(() => sessionStorage.setItem('ks-auth', '1'));

    const wkBesøkte = new Set();
    const wkKø = [START_URL];
    const wkOppdagetFraMap = new Map();
    wkOppdagetFraMap.set(START_URL.replace(/\/$/, '') || START_URL, null);
    const wkSider = [];
    let wkSideIndeks = 0;

    while (wkKø.length > 0 && wkBesøkte.size < MAX_SIDER) {
      const wkUrl = wkKø.shift();
      const wkNorm = wkUrl.replace(/\/$/, '') || START_URL;
      if (wkBesøkte.has(wkNorm)) continue;
      wkBesøkte.add(wkNorm);
      wkSideIndeks++;
      console.log(`  🧭 [${wkBesøkte.size}/${MAX_SIDER}] Analyserer: ${wkNorm}`);
      const res = await analyserSide(wkNorm, wkSideIndeks, wkOppdagetFraMap.get(wkNorm) ?? null, wkCtx, false, skjermDir);
      if (res) {
        wkSider.push(res);
        for (const lenke of res.internelenker) {
          const norm = lenke.replace(/\/$/, '');
          if (!wkBesøkte.has(norm) && !wkKø.includes(norm)) {
            wkKø.push(norm);
            if (!wkOppdagetFraMap.has(norm)) wkOppdagetFraMap.set(norm, wkNorm);
          }
        }
      }
    }

    const wkTastatur = await kjørTastaturSjekker(wkCtx, START_URL);
    const wkReflow = await kjørReflowSjekk(wkCtx, START_URL);
    const wkTekstmellomrom = await kjørTekstmellomromSjekk(wkCtx, START_URL);
    const wkEkstraWcag = await kjørEkstraWcagSjekker(wkCtx, START_URL);
    await wkBrowser.close();

    const wkTotalt = beregnTotaltFraRun(wkSider, wkTastatur, wkReflow, wkTekstmellomrom, wkEkstraWcag);
    webkitRun = {
      fast: { bruker: testdata.bruker, sider: wkSider, tastatur: wkTastatur, reflow: wkReflow, tekstmellomrom: wkTekstmellomrom, ekstraWcag: wkEkstraWcag, totalt: wkTotalt },
      tilfeldig: null
    };
    console.log(`🧭 WebKit: ${wkTotalt.sider} sider · ${wkTotalt.wcagBrudd} WCAG-brudd`);
  } catch (e) {
    console.log(`⚠️  WebKit-test feilet: ${e.message.slice(0, 80)}`);
  }
}

// Aggregert oppsummering
const alleViolasjonIds = sideResultater.flatMap(s => (s.wcag?.detaljer ?? []).map(v => ({ id: v.id, impact: v.impact })));
const totalt = {
  sider: sideResultater.length,
  wcagBrudd: sideResultater.reduce((s, r) => s + r.wcag.brudd, 0),
  kritiske: sideResultater.reduce((s, r) => s + r.wcag.kritiske, 0),
  alvorlige: sideResultater.reduce((s, r) => s + r.wcag.alvorlige, 0),
  moderate: sideResultater.reduce((s, r) => s + r.wcag.moderate, 0),
  mindre: sideResultater.reduce((s, r) => s + r.wcag.mindre, 0),
  uniqKritiske: new Set(alleViolasjonIds.filter(v => v.impact === 'critical').map(v => v.id)).size,
  uniqAlvorlige: new Set(alleViolasjonIds.filter(v => v.impact === 'serious').map(v => v.id)).size,
  uniqModerate: new Set(alleViolasjonIds.filter(v => v.impact === 'moderate').map(v => v.id)).size,
  uniqMindre: new Set(alleViolasjonIds.filter(v => v.impact === 'minor').map(v => v.id)).size,
  dødelenker: sideResultater.reduce((s, r) => s + r.lenker.døde.length, 0),
  knapper: sideResultater.reduce((s, r) => s + r.knapper.length, 0),
  knappUtenLabel: sideResultater.reduce((s, r) => s + r.knapper.filter(k => !k.harLabel).length, 0),
  bilder: sideResultater.reduce((s, r) => s + r.bilder.length, 0),
  bilderUtenAlt: sideResultater.reduce((s, r) => s + r.bilder.filter(b => !b.harAlt).length, 0),
  skjemafelt: sideResultater.reduce((s, r) => s + r.skjemafelt.length, 0),
  feltUtenLabel: sideResultater.reduce((s, r) => s + r.skjemafelt.filter(f => !f.harLabel).length, 0),
  tastaturFeil: tastatur.feil,
  tastaturAdvarsel: tastatur.advarsel,
  reflowFeil: reflow.feil,
  reflowAdvarsel: reflow.advarsel,
  tekstmellomromFeil: tekstmellomrom.feil,
  tekstmellomromAdvarsel: tekstmellomrom.advarsel,
  ekstraFeil: ekstraWcag.feil,
  ekstraAdvarsel: ekstraWcag.advarsel,
};

// Lagre JSON (uten bildedata for å holde størrelsen nede)
fs.writeFileSync(path.join(rapportDir, 'resultat.json'), JSON.stringify({ url: START_URL, dato, versjon, nettleser, totalt, tastatur, reflow, tekstmellomrom, ekstraWcag, firefoxRun: firefoxRun ? { totalt: firefoxRun.fast.totalt, tastatur: firefoxRun.fast.tastatur, reflow: firefoxRun.fast.reflow, tekstmellomrom: firefoxRun.fast.tekstmellomrom, ekstraWcag: firefoxRun.fast.ekstraWcag } : null, webkitRun: webkitRun ? { totalt: webkitRun.fast.totalt, tastatur: webkitRun.fast.tastatur, reflow: webkitRun.fast.reflow, tekstmellomrom: webkitRun.fast.tekstmellomrom, ekstraWcag: webkitRun.fast.ekstraWcag } : null, sider: sideResultater.map(s => ({ ...s, wcag: { ...s.wcag, detaljer: s.wcag.detaljer.map(v => ({ ...v, bilder: v.bilder })) } })) }, null, 2));

// Generer HTML
fs.writeFileSync(path.join(rapportDir, 'uu-rapport.html'), genererRapport(START_URL, dato, tidspunkt, totalt, sideResultater, versjon, tastatur, nettleser, reflow, tekstmellomrom, [], ekstraWcag, testdata, null, firefoxRun, webkitRun));

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
console.log(`📱 Reflow (1.4.10):  ${reflow.bestått} bestått · ${farge(reflow.advarsel, 0, 0, 2)} adv. · ${farge(reflow.feil, 0, 0, 1)} feil`);
console.log(`📐 Tekstmellomrom:   ${tekstmellomrom.bestått} bestått · ${farge(tekstmellomrom.advarsel, 0, 0, 2)} adv. · ${farge(tekstmellomrom.feil, 0, 0, 1)} feil`);
console.log(`🔎 Ekstra WCAG:      ${ekstraWcag.bestått} bestått · ${farge(ekstraWcag.advarsel, 0, 0, 2)} adv. · ${farge(ekstraWcag.feil, 0, 0, 1)} feil`);
console.log('━'.repeat(60));
console.log(`\n📁 HTML-rapport: ${path.join(rapportDir, 'uu-rapport.html')}\n`);
const { exec } = await import('child_process');
exec(`open "${path.join(rapportDir, 'uu-rapport.html')}"`);

function farge(n, grønn, gul, rød) {
  if (n <= grønn) return `\x1b[32m${n}\x1b[0m`;
  if (n <= gul) return `\x1b[33m${n}\x1b[0m`;
  return `\x1b[31m${n}\x1b[0m`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreBeregn(t) {
  // Axe-core: fradrag basert på unike regeltyper (ikke per side-forekomst)
  const axe = (t.uniqKritiske ?? t.kritiske) * 15
            + (t.uniqAlvorlige ?? t.alvorlige) * 8
            + (t.uniqModerate  ?? t.moderate)  * 3
            + (t.uniqMindre    ?? t.mindre)    * 1;
  // Øvrige funn: per forekomst, men med tak slik at gjentakelser på mange sider ikke nullstiller alt
  const lenker  = Math.min(t.dødelenker    * 4, 20);
  const knapper = Math.min(t.knappUtenLabel * 2, 15);
  const bilder  = Math.min(t.bilderUtenAlt  * 2, 10);
  const felt    = Math.min(t.feltUtenLabel  * 2, 10);
  const tastatur  = (t.tastaturFeil  || 0) * 10 + (t.tastaturAdvarsel  || 0) * 3;
  const reflow    = (t.reflowFeil    || 0) * 8  + (t.reflowAdvarsel    || 0) * 2;
  const mellomrom = (t.tekstmellomromFeil || 0) * 5 + (t.tekstmellomromAdvarsel || 0) * 1;
  const ekstra    = (t.ekstraFeil    || 0) * 8  + (t.ekstraAdvarsel    || 0) * 1;
  return Math.max(0, 100 - axe - lenker - knapper - bilder - felt - tastatur - reflow - mellomrom - ekstra);
}

function badge(n, klasse, tekst) {
  if (n === 0) return '';
  return `<span class="badge ${klasse}">${n} ${tekst}</span>`;
}

function impactFarge(impact) {
  return { critical: '#c53030', serious: '#9a3412', moderate: '#b8860b', minor: '#6b7280' }[impact] || '#6b7280';
}

function genererRapport(url, dato, tidspunkt, totalt, sider, versjon = null, tastatur = { tester: [], bestått: 0, feil: 0, advarsel: 0 }, nettleser = '', reflow = { tester: [], bestått: 0, feil: 0, advarsel: 0 }, tekstmellomrom = { tester: [], bestått: 0, feil: 0, advarsel: 0 }, innloggingsSteg = [], ekstraWcag = { tester: [], bestått: 0, feil: 0, advarsel: 0 }, testdata = {}, ekstraRun = null, firefoxRun = null, webkitRun = null) {
  const s = scoreBeregn(totalt);
  const scoreKlasse = s >= 80 ? 'god' : s >= 50 ? 'middels' : 'dårlig';

  // WCAG 2.1 – testbare kriterier
  const WCAG_INFO = {
    '1.1.1': { navn: 'Ikke-tekstlig innhold', kilde: 'axe-core', level: 'A', prinsipp: 1, tags: ['wcag111'] },
    '1.3.1': { navn: 'Informasjon og relasjoner', kilde: 'axe-core', level: 'A', prinsipp: 1, tags: ['wcag131'] },
    '1.3.4': { navn: 'Orientering', kilde: 'ekstra-sjekk', level: 'AA', prinsipp: 1, ekstraKat: ['orientering'] },
    '1.4.3': { navn: 'Kontrast (minimum)', kilde: 'axe-core', level: 'AA', prinsipp: 1, tags: ['wcag143'] },
    '1.4.10': { navn: 'Reflow – 320px / 400 % zoom', kilde: 'reflow', level: 'AA', prinsipp: 1, reflowKat: ['reflow', 'klipping'] },
    '1.4.12': { navn: 'Tekstmellomrom', kilde: 'tekstmellomrom', level: 'AA', prinsipp: 1, mellomromKat: ['klipping', 'overflyt'] },
    '1.4.13': { navn: 'Innhold ved pek eller fokus', kilde: 'ekstra-sjekk', level: 'AA', prinsipp: 1, ekstraKat: ['hover-fokus'] },
    '2.1.1': { navn: 'Tastatur', kilde: 'tastatur-sjekk', level: 'A', prinsipp: 2, tags: ['wcag211'], tastaturKat: ['rekkevidden', 'aktivering'] },
    '2.1.2': { navn: 'Ingen tastaturfelle', kilde: 'tastatur-sjekk', level: 'A', prinsipp: 2, tastaturKat: ['tastaturfelle'] },
    '2.4.1': { navn: 'Hoppe over blokker (skiplink)', kilde: 'tastatur-sjekk', level: 'A', prinsipp: 2, tastaturKat: ['hopplenke'] },
    '2.4.2': { navn: 'Sidetittel', kilde: 'axe-core', level: 'A', prinsipp: 2, tags: ['wcag242'] },
    '2.4.3': { navn: 'Fokusrekkefølge', kilde: 'tastatur-sjekk', level: 'A', prinsipp: 2, tastaturKat: ['tabindeks'] },
    '2.4.4': { navn: 'Formål med lenke (i kontekst)', kilde: 'axe-core', level: 'A', prinsipp: 2, tags: ['wcag244'] },
    '2.4.7': { navn: 'Synlig fokus', kilde: 'tastatur-sjekk', level: 'AA', prinsipp: 2, tastaturKat: ['synligfokus'] },
    '3.2.1': { navn: 'Fokus – ingen uventet kontekstendring', kilde: 'ekstra-sjekk', level: 'A', prinsipp: 3, ekstraKat: ['fokus-kontekst'] },
    '3.2.2': { navn: 'Inndata – ingen uventet kontekstendring', kilde: 'ekstra-sjekk', level: 'A', prinsipp: 3, ekstraKat: ['inndata-kontekst'] },
    '3.3.1': { navn: 'Feilidentifikasjon', kilde: 'ekstra-sjekk', level: 'A', prinsipp: 3, ekstraKat: ['feilidentifikasjon'] },
    '4.1.1': { navn: 'Parsing', kilde: 'axe-core', level: 'A', prinsipp: 4, tags: ['wcag411'] },
    '4.1.2': { navn: 'Navn, rolle, verdi', kilde: 'axe-core', level: 'A', prinsipp: 4, tags: ['wcag412'] },
  };
  const PRINSIPP_NAVN = { 1: 'Mulig å oppfatte', 2: 'Mulig å betjene', 3: 'Mulig å forstå', 4: 'Robust' };

  const UUTIL_URLS = {
    '1.1.1':  'https://www.uutilsynet.no/wcag-standarden/111-ikke-tekstlig-innhold-niva/87',
    '1.2.1':  'https://www.uutilsynet.no/wcag-standarden/121-bare-lyd-og-bare-video-forhandsinnspilt-niva/88',
    '1.2.2':  'https://www.uutilsynet.no/wcag-standarden/122-teksting-forhandsinnspilt-niva/89',
    '1.2.5':  'https://www.uutilsynet.no/wcag-standarden/125-synstolking-forhandsinnspilt-niva-aa/842',
    '1.3.1':  'https://www.uutilsynet.no/wcag-standarden/131-informasjon-og-relasjoner-niva/90',
    '1.3.2':  'https://www.uutilsynet.no/wcag-standarden/132-meningsfylt-rekkefolge-niva/91',
    '1.3.3':  'https://www.uutilsynet.no/wcag-standarden/133-sensoriske-egenskaper-niva/92',
    '1.3.4':  'https://www.uutilsynet.no/wcag-standarden/134-visningsretning-niva-aa/141',
    '1.3.5':  'https://www.uutilsynet.no/wcag-standarden/135-identifiser-formal-med-inndata-niva-aa/142',
    '1.4.1':  'https://www.uutilsynet.no/wcag-standarden/141-bruk-av-farge-niva/93',
    '1.4.2':  'https://www.uutilsynet.no/wcag-standarden/142-styring-av-lyd-niva/94',
    '1.4.3':  'https://www.uutilsynet.no/wcag-standarden/143-kontrast-minimum-niva-aa/95',
    '1.4.4':  'https://www.uutilsynet.no/wcag-standarden/144-endring-av-tekststorrelse-niva-aa/96',
    '1.4.5':  'https://www.uutilsynet.no/wcag-standarden/145-bilder-av-tekst-niva-aa/97',
    '1.4.10': 'https://www.uutilsynet.no/wcag-standarden/1410-dynamisk-tilpasning-reflow-niva-aa/144',
    '1.4.11': 'https://www.uutilsynet.no/wcag-standarden/1411-kontrast-ikke-tekstlig-innhold-niva-aa/145',
    '1.4.12': 'https://www.uutilsynet.no/wcag-standarden/1412-tekstavstand-niva-aa/146',
    '1.4.13': 'https://www.uutilsynet.no/wcag-standarden/1413-pekerfolsomt-innhold-eller-innhold-ved-tastaturfokus-niva-aa/147',
    '2.1.1':  'https://www.uutilsynet.no/wcag-standarden/211-tastatur-niva/98',
    '2.1.2':  'https://www.uutilsynet.no/wcag-standarden/212-ingen-tastaturfelle-niva/99',
    '2.1.4':  'https://www.uutilsynet.no/wcag-standarden/214-hurtigtaster-som-bestar-av-ett-tegn-niva/782',
    '2.2.1':  'https://www.uutilsynet.no/wcag-standarden/221-justerbar-hastighet-niva/100',
    '2.2.2':  'https://www.uutilsynet.no/wcag-standarden/222-pause-stopp-skjul-niva/101',
    '2.3.1':  'https://www.uutilsynet.no/wcag-standarden/231-terskelverdi-pa-maksimalt-tre-glimt-niva/102',
    '2.4.1':  'https://www.uutilsynet.no/wcag-standarden/241-hoppe-over-blokker-niva/103',
    '2.4.2':  'https://www.uutilsynet.no/wcag-standarden/242-sidetitler-niva/104',
    '2.4.3':  'https://www.uutilsynet.no/wcag-standarden/243-fokusrekkefolge-niva/105',
    '2.4.4':  'https://www.uutilsynet.no/wcag-standarden/244-formal-med-lenke-i-kontekst-niva/106',
    '2.4.5':  'https://www.uutilsynet.no/wcag-standarden/245-flere-mater-niva-aa/107',
    '2.4.6':  'https://www.uutilsynet.no/wcag-standarden/246-overskrifter-og-ledetekster-niva-aa/108',
    '2.4.7':  'https://www.uutilsynet.no/wcag-standarden/247-synlig-fokus-niva-aa/109',
    '2.5.1':  'https://www.uutilsynet.no/wcag-standarden/251-pekerbevegelser-niva/148',
    '2.5.2':  'https://www.uutilsynet.no/wcag-standarden/252-pekeravbrytelse-niva/149',
    '2.5.3':  'https://www.uutilsynet.no/wcag-standarden/253-ledetekst-i-navn-niva/150',
    '2.5.4':  'https://www.uutilsynet.no/wcag-standarden/254-bevegelsesaktivering-niva/151',
    '3.1.1':  'https://www.uutilsynet.no/wcag-standarden/311-sprak-pa-siden-niva/110',
    '3.1.2':  'https://www.uutilsynet.no/wcag-standarden/312-sprak-pa-deler-av-innhold-niva-aa/111',
    '3.2.1':  'https://www.uutilsynet.no/wcag-standarden/321-fokus-niva/112',
    '3.2.2':  'https://www.uutilsynet.no/wcag-standarden/322-inndata-niva/114',
    '3.2.3':  'https://www.uutilsynet.no/wcag-standarden/323-konsekvent-navigering-niva-aa/113',
    '3.2.4':  'https://www.uutilsynet.no/wcag-standarden/324-konsekvent-identifikasjon-niva-aa/115',
    '3.3.1':  'https://www.uutilsynet.no/wcag-standarden/331-identifikasjon-av-feil-niva/116',
    '3.3.2':  'https://www.uutilsynet.no/wcag-standarden/332-ledetekster-eller-instruksjoner-niva/117',
    '3.3.3':  'https://www.uutilsynet.no/wcag-standarden/333-forslag-ved-feil-niva-aa/118',
    '3.3.4':  'https://www.uutilsynet.no/wcag-standarden/334-forhindring-av-feil-juridiske-feil-okonomiske-feil-datafeil-niva-aa/119',
    '4.1.1':  'https://www.uutilsynet.no/wcag-standarden/411-parsing-oppdeling-niva/120',
    '4.1.2':  'https://www.uutilsynet.no/wcag-standarden/412-navn-rolle-verdi-niva/121',
    '4.1.3':  'https://www.uutilsynet.no/wcag-standarden/413-statusbeskjeder-niva-aa/152',
  };

  function wMatch(v, id) {
    return (v.tags ?? []).some(tag => { const m = tag.match(/^wcag(\d)(\d)(\d+)$/); return m ? `${m[1]}.${m[2]}.${m[3]}` === id : false; });
  }

  function worstSt(a, b) { const r = ['ok', 'advarsel', 'feil']; return r[Math.max(r.indexOf(a), r.indexOf(b))]; }

  function kSt(id, info, sp, ta, re, me, ek) {
    let st = 'ok';
    if (info.tags?.length) {
      outer: for (const side of sp) { for (const v of (side.wcag?.detaljer ?? [])) { if (wMatch(v, id)) { st = 'feil'; break outer; } } }
    }
    const upd = (tstr, kat) => { for (const t of (tstr?.tester ?? [])) { if (kat.includes(t.kategori)) st = worstSt(st, t.resultat === 'feil' ? 'feil' : t.resultat === 'advarsel' ? 'advarsel' : 'ok'); } };
    if (info.tastaturKat)  upd(ta, info.tastaturKat);
    if (info.reflowKat)    upd(re, info.reflowKat);
    if (info.mellomromKat) upd(me, info.mellomromKat);
    if (info.ekstraKat)    upd(ek, info.ekstraKat);
    return st;
  }

  function innholdAxe(id, sp) {
    const brudd = sp.map(side => ({ ...side, rel: (side.wcag?.detaljer ?? []).filter(v => wMatch(v, id)) })).filter(s => s.rel.length > 0);
    if (!brudd.length) return '<div class="ok-rad">✅ Bestått – ingen brudd funnet</div>';
    return brudd.map(side => `<div class="side-rad">
      <div class="side-rad-header">
        <a href="${side.url}" target="_blank" class="side-lenke">${escapeHtml(side.tittel || side.url)}</a>
        <span class="side-url-kort">${escapeHtml(side.url.replace(url.replace(/\/$/, ''), '') || '/')}</span>
      </div>
      ${side.rel.map(v => `<div class="brudd-linje">
        <span class="badge ${v.impact}">${v.impact}</span>
        <code class="regel-id">${escapeHtml(v.id)}</code>
        <span class="regel-desc">${escapeHtml(v.description)}</span>
        <span class="node-teller">${v.nodes.length} element${v.nodes.length !== 1 ? 'er' : ''}</span>
      </div>
      ${v.bilder?.nærbilde || v.bilder?.helside ? `<details style="margin:.2rem 0 .5rem 0">
        <summary style="cursor:pointer;font-size:.72rem;color:#2b3285;user-select:none;list-style:none;display:inline-flex;align-items:center;gap:.3rem">📸 Vis skjermdumper ▾</summary>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.7rem;margin-top:.5rem;padding:.6rem .7rem;background:#f8f7f5;border:1px solid #ede9e3">
          ${v.bilder?.nærbilde ? `<div>
            <p style="font-size:.67rem;color:#6b7280;margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.05em">📍 Nærbilde av element</p>
            <a href="${v.bilder.nærbilde}" target="_blank">
              <img src="${v.bilder.nærbilde}" loading="lazy" alt="Nærbilde av feilende element" style="width:100%;max-height:180px;object-fit:contain;border:1px solid #e5e3de;background:white;cursor:zoom-in;display:block">
            </a>
          </div>` : ''}
          ${v.bilder?.helside ? `<div>
            <p style="font-size:.67rem;color:#6b7280;margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.05em">🖥️ Sidekontekst</p>
            <a href="${v.bilder.helside}" target="_blank">
              <img src="${v.bilder.helside}" loading="lazy" alt="Skjermdump av siden med feilende element" style="width:100%;max-height:180px;object-fit:cover;object-position:top;border:1px solid #e5e3de;cursor:zoom-in;display:block">
            </a>
          </div>` : ''}
        </div>
      </details>` : ''}`).join('')}
    </div>`).join('');
  }

  function innholdSjekk(kat, tstr) {
    const rel = (tstr?.tester ?? []).filter(t => kat.includes(t.kategori));
    if (!rel.length) return '<div class="ok-rad">✅ Bestått – ingen data</div>';
    return `<div class="sjekk-liste">${rel.map(t => {
      const bg = t.resultat === 'bestått' ? '#ecfdf5' : t.resultat === 'feil' ? '#fee2e2' : '#fef3c7';
      const fg = t.resultat === 'bestått' ? '#064e3b' : t.resultat === 'feil' ? '#c53030' : '#92400e';
      const ik = t.resultat === 'bestått' ? '✅' : t.resultat === 'feil' ? '❌' : '⚠️';
      return `<div class="sjekk-rad"><span class="sjekk-status" style="background:${bg};color:${fg}">${ik} ${t.resultat}</span><span class="sjekk-navn">${escapeHtml(t.navn)}</span>${t.detalj ? `<span class="sjekk-detalj">${escapeHtml(t.detalj)}</span>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function kriterieInnholdFn(id, info, sp, ta, re, me, ek) {
    let html = '';
    if (info.tags?.length)   html += innholdAxe(id, sp);
    if (info.tastaturKat)    html += innholdSjekk(info.tastaturKat, ta);
    if (info.reflowKat)      html += innholdSjekk(info.reflowKat, re);
    if (info.mellomromKat)   html += innholdSjekk(info.mellomromKat, me);
    if (info.ekstraKat)      html += innholdSjekk(info.ekstraKat, ek);
    return html || '<div class="ok-rad">✅ Bestått</div>';
  }

  function kjøringContainerFn(id, info, sp, ta, re, me, ek, fnr, erTilfeldig) {
    const farge = erTilfeldig ? '#065f46' : '#0a1355';
    const border = erTilfeldig ? '#a7f3d0' : '#f4ecdf';
    const ikon  = erTilfeldig ? '🎲' : '🔐';
    const label = erTilfeldig ? 'Tilfeldig bruker' : 'Fast bruker';
    return `<details open style="margin-top:.5rem;border:1px solid #e5e3de;border-radius:4px;background:white;box-shadow:0 1px 3px rgba(10,19,85,.04)">
    <summary style="cursor:pointer;padding:.7rem 1rem;font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${farge};user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
      <span>${ikon} ${label} <code style="font-size:.71rem;font-weight:700;color:${farge};background:none;margin-left:.3rem">${escapeHtml(fnr ?? 'ukjent')}</code></span>
      <span style="font-size:.71rem;opacity:.45;font-weight:400;text-transform:none;letter-spacing:0">klikk for å lukke ▲</span>
    </summary>
    <div style="padding:.75rem 1rem 1rem;border-top:1px solid ${border}">
      ${kriterieInnholdFn(id, info, sp, ta, re, me, ek)}
    </div>
  </details>`;
  }

  // Kombiner status for alle kjøringer (verste vinner)
  const kStatus = {};
  for (const [id, info] of Object.entries(WCAG_INFO)) {
    const s1 = kSt(id, info, sider, tastatur, reflow, tekstmellomrom, ekstraWcag);
    const s2 = ekstraRun ? kSt(id, info, ekstraRun.sider ?? [], ekstraRun.tastatur, ekstraRun.reflow, ekstraRun.tekstmellomrom, ekstraRun.ekstraWcag) : 'ok';
    const s3 = firefoxRun ? kSt(id, info, firefoxRun.fast.sider, firefoxRun.fast.tastatur, firefoxRun.fast.reflow, firefoxRun.fast.tekstmellomrom, firefoxRun.fast.ekstraWcag) : 'ok';
    const s5 = webkitRun ? kSt(id, info, webkitRun.fast.sider, webkitRun.fast.tastatur, webkitRun.fast.reflow, webkitRun.fast.tekstmellomrom, webkitRun.fast.ekstraWcag) : 'ok';
    kStatus[id] = worstSt(worstSt(worstSt(s1, s2), s3), s5);
  }

  const sidenavigasjon = [1, 2, 3, 4].flatMap(p => [
    `<li class="wcag-prinsipp-header">Prinsipp ${p}: ${PRINSIPP_NAVN[p]}</li>`,
    ...Object.entries(WCAG_INFO).filter(([, info]) => info.prinsipp === p).map(([id]) => {
      const st = kStatus[id];
      const cls = st === 'feil' ? 'har-brudd' : st === 'advarsel' ? 'har-advarsel' : 'ok';
      const ik = st === 'feil' ? '❌' : st === 'advarsel' ? '⚠️' : '✅';
      return `<li><a href="#wcag-${id.replace(/\./g, '-')}" class="sidenav-link ${cls}">
        <span class="sidenavn">${id}</span>
        <span class="side-url">${WCAG_INFO[id].navn}</span>
        <span class="side-badge">${ik} ${st}</span>
      </a></li>`;
    }),
  ]).join('');

  const wcagSeksjonerHtml = [1, 2, 3, 4].map(p => {
    const kriterier = Object.entries(WCAG_INFO).filter(([, info]) => info.prinsipp === p);
    return `<div class="prinsipp-gruppe">
    <div class="prinsipp-label">Prinsipp ${p} – ${PRINSIPP_NAVN[p]}</div>
    ${kriterier.map(([id, info]) => {
      const st = kStatus[id];
      const ik = st === 'feil' ? '❌' : st === 'advarsel' ? '⚠️' : '✅';
      const badgeKls = st === 'feil' ? 'feil' : st === 'advarsel' ? 'advarsel' : 'bestått';
      let badgeTekst;
      if (st === 'ok') {
        badgeTekst = 'Bestått';
      } else if (info.tags?.length) {
        const uniqSider = new Set([
          ...sider.filter(s => (s.wcag?.detaljer ?? []).some(v => wMatch(v, id))).map(s => s.url),
        ]);
        const n = uniqSider.size;
        badgeTekst = `${n} side${n !== 1 ? 'r' : ''} med brudd`;
      } else {
        badgeTekst = st === 'feil' ? 'Feil' : 'Advarsel';
      }
      const ffFastSider = firefoxRun?.fast.sider ?? [];
      const wkFastSider = webkitRun?.fast.sider ?? [];
      return `<section class="kriterie-seksjon" id="wcag-${id.replace(/\./g, '-')}">
        <div class="kriterie-header">
          <div>
            <div class="kriterie-nummerrad">
              <span class="kriterie-num">${id}</span>
              <span class="level-badge level-${info.level.toLowerCase()}">${info.level}</span>
              <span class="kilde-chip">${info.kilde}</span>
            </div>
            <h2 class="kriterie-navn">${ik} ${escapeHtml(info.navn)}</h2>
          </div>
          <div><span class="status-badge ${badgeKls}">${badgeTekst}</span></div>
        </div>
        <details open style="margin-top:.5rem;border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff">
          <summary style="cursor:pointer;padding:.6rem 1rem;font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#1d4ed8;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
            <span>🌐 Chromium</span>
            <span style="font-size:.71rem;opacity:.45;font-weight:400;text-transform:none;letter-spacing:0">klikk for å lukke ▲</span>
          </summary>
          <div style="padding:.5rem .75rem .75rem">
            ${kjøringContainerFn(id, info, sider, tastatur, reflow, tekstmellomrom, ekstraWcag, testdata.bruker, false)}
          </div>
        </details>
        ${firefoxRun ? `<details open style="margin-top:.4rem;border:1px solid #fde68a;border-radius:4px;background:#fffbeb">
          <summary style="cursor:pointer;padding:.6rem 1rem;font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#92400e;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
            <span>🦊 Firefox</span>
            <span style="font-size:.71rem;opacity:.45;font-weight:400;text-transform:none;letter-spacing:0">klikk for å lukke ▲</span>
          </summary>
          <div style="padding:.5rem .75rem .75rem">
            ${kjøringContainerFn(id, info, ffFastSider, firefoxRun.fast.tastatur, firefoxRun.fast.reflow, firefoxRun.fast.tekstmellomrom, firefoxRun.fast.ekstraWcag, firefoxRun.fast.bruker, false)}
          </div>
        </details>` : ''}
        ${webkitRun ? `<details open style="margin-top:.4rem;border:1px solid #d8b4fe;border-radius:4px;background:#faf5ff">
          <summary style="cursor:pointer;padding:.6rem 1rem;font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#7e22ce;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
            <span>🧭 WebKit (Safari)</span>
            <span style="font-size:.71rem;opacity:.45;font-weight:400;text-transform:none;letter-spacing:0">klikk for å lukke ▲</span>
          </summary>
          <div style="padding:.5rem .75rem .75rem">
            ${kjøringContainerFn(id, info, wkFastSider, webkitRun.fast.tastatur, webkitRun.fast.reflow, webkitRun.fast.tekstmellomrom, webkitRun.fast.ekstraWcag, webkitRun.fast.bruker, false)}
          </div>
        </details>` : ''}
      </section>`;
    }).join('')}
  </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<script>if(location.protocol!=='file:'&&!sessionStorage.getItem('ks-auth'))location.replace('logg-inn.html?redir='+encodeURIComponent(location.href))</script>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
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
  .sidenav-link.har-advarsel{border-color:#fcd34d}
  .sidenav-link.ok{border-color:#abd1b1}
  .sidenavn{display:block;font-size:.84rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .side-url{display:block;font-size:.68rem;opacity:.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.15rem}
  .side-badge{display:block;font-size:.68rem;margin-top:.2rem;opacity:.6}
  .wcag-prinsipp-header{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.3);padding:.9rem 1.4rem .35rem;margin-top:.25rem;list-style:none}

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
  summary.side-header{list-style:none;cursor:pointer;user-select:none}
  summary.side-header::-webkit-details-marker{display:none}
  details.side-seksjon:not([open]) summary.side-header{margin-bottom:0;padding-bottom:0;border-bottom:none}
  summary.side-header::after{content:'▾ Vis detaljer';font-size:.68rem;color:#9ca3af;white-space:nowrap;align-self:center;flex-shrink:0}
  details[open] summary.side-header::after{content:'▴ Skjul'}
  .side-url-link{font-size:.78rem;color:#07604f;text-decoration:none;display:block;margin-top:.2rem}
  .side-url-link:hover{text-decoration:underline}
  .side-score-badges{display:flex;gap:.4rem;flex-wrap:wrap;align-items:flex-start}

  /* Testdata strip */
  .testdata-strip{display:flex;gap:.5rem;flex-wrap:wrap;padding:.7rem 0 .9rem;border-bottom:1px solid #f4ecdf;margin-bottom:1rem}
  .testdata-chip{display:inline-flex;align-items:center;gap:.25rem;background:#f4ecdf;color:#374151;padding:.18rem .65rem;border-radius:100px;font-size:.71rem;font-weight:500}

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

  /* WCAG-kriterie-layout */
  .prinsipp-gruppe{margin-bottom:.5rem}
  .prinsipp-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#0a1355;padding:.7rem 0 .4rem;border-bottom:2px solid #f4ecdf;margin-bottom:.6rem;margin-top:2rem}
  .kriterie-seksjon{background:white;border:1px solid #f1f0ee;padding:1.4rem 1.6rem;margin-bottom:.7rem;box-shadow:0 1px 4px rgba(10,19,85,.05)}
  .kriterie-header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem}
  .kriterie-nummerrad{display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem}
  .kriterie-num{font-size:.8rem;font-weight:700;color:#2b3285;font-family:ui-monospace,monospace}
  .level-badge{font-size:.65rem;font-weight:700;padding:.1rem .45rem;border-radius:3px}
  .level-a{background:#fee2e2;color:#c53030}
  .level-aa{background:#eff6ff;color:#1d4ed8}
  .kilde-chip{font-size:.65rem;background:#f4ecdf;color:#713f12;padding:.1rem .5rem;border-radius:100px}
  .kriterie-navn{font-size:.95rem;font-weight:600;color:#0a1355}
  .status-badge{display:inline-block;padding:.2rem .7rem;border-radius:100px;font-size:.7rem;font-weight:600}
  .status-badge.feil{background:#fee2e2;color:#c53030}
  .status-badge.advarsel{background:#fef3c7;color:#92400e}
  .status-badge.bestått{background:#ecfdf5;color:#065f46}
  .ok-rad{font-size:.83rem;color:#065f46;padding:.5rem .7rem;background:#ecfdf5;border-left:3px solid #07604f}
  .side-rad{margin:.5rem 0;padding:.6rem .8rem;background:#faf6f0;border-left:3px solid #e5e3de}
  .side-rad-header{margin-bottom:.4rem}
  .side-lenke{font-size:.83rem;font-weight:600;color:#0a1355;text-decoration:none}
  .side-lenke:hover{text-decoration:underline}
  .side-url-kort{display:block;font-size:.7rem;color:#9ca3af;margin-top:.1rem}
  .brudd-linje{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-size:.8rem;margin:.3rem 0;padding:.25rem 0;border-top:1px solid #f1f0ee}
  .node-teller{font-size:.72rem;color:#9ca3af;margin-left:auto;white-space:nowrap}
  .sjekk-liste{display:flex;flex-direction:column;gap:.3rem}
  .sjekk-rad{display:flex;align-items:center;gap:.6rem;font-size:.82rem;flex-wrap:wrap}
  .sjekk-status{padding:.15rem .55rem;border-radius:100px;font-size:.7rem;font-weight:600;flex-shrink:0}
  .sjekk-navn{flex:1}
  .sjekk-detalj{font-size:.75rem;color:#6b7280;font-style:italic}
  .sider-liste{display:flex;flex-direction:column;gap:.25rem}
  .side-url-rad{padding:.4rem .7rem;background:#faf6f0;border-left:3px solid #e5e3de;font-size:.82rem}
  .side-url-rad a{color:#0a1355;text-decoration:none;font-weight:500}
  .side-url-rad a:hover{text-decoration:underline}
  .side-path{display:block;font-size:.72rem;color:#9ca3af}
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
      <div class="meta"><a href="${url}" target="_blank">${url}</a> · ${dato} ${tidspunkt} · ${totalt.sider} sider testet${nettleser ? ` · 🌐 Chromium ${nettleser.split('.')[0]}` : ''}${firefoxRun ? ' · 🦊 Firefox' : ''}${webkitRun ? ' · 🧭 WebKit' : ''}</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp aktiv">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="ytelse-rapport.html" class="knapp sekundær">Ytelsestest</a>
      <a href="brukerhistorie-rapport.html" class="knapp sekundær">Brukerhistorier</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
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
          <li>📱 Reflow ved 320px (1.4.10)</li>
          <li>📐 Tekstmellomrom-klipping (1.4.12)</li>
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

  <div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem;margin-bottom:-.2rem">
    <button onclick="document.querySelectorAll('details').forEach(d=>d.open=true)" style="background:transparent;border:1px solid #d1d5db;color:#374151;font-size:.75rem;padding:.3rem .85rem;border-radius:100px;cursor:pointer;font-family:inherit;transition:background .15s" onmouseover="this.style.background='#f4ecdf'" onmouseout="this.style.background='transparent'">↕ Åpne alle</button>
    <button onclick="document.querySelectorAll('details').forEach(d=>d.open=false)" style="background:transparent;border:1px solid #d1d5db;color:#374151;font-size:.75rem;padding:.3rem .85rem;border-radius:100px;cursor:pointer;font-family:inherit;transition:background .15s" onmouseover="this.style.background='#f4ecdf'" onmouseout="this.style.background='transparent'">↕ Lukk alle</button>
  </div>

  <details style="margin-top:1.5rem;border:1px solid #e5e3de;background:white;box-shadow:0 1px 4px rgba(10,19,85,.06)">
    <summary style="cursor:pointer;padding:1rem 1.5rem;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
      <span>📄 Sider analysert (${totalt.sider} sider)</span>
      <span style="font-size:.75rem;opacity:.5;font-weight:400;text-transform:none;letter-spacing:0">klikk for å utvide ▼</span>
    </summary>
    <div style="padding:1.2rem 1.5rem 1.5rem;border-top:1px solid #f4ecdf">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.2rem">
        <div style="border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff;padding:.8rem">
          <div style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#1d4ed8;margin-bottom:.6rem">🌐 Chromium</div>
          <div style="font-size:.72rem;font-weight:600;color:#0a1355;margin-bottom:.5rem">🔐 Fast bruker (${escapeHtml(testdata.bruker ?? 'ukjent')})</div>
          <div class="sider-liste">
            ${sider.map(side => `<div class="side-url-rad">
              <a href="${side.url}" target="_blank">${escapeHtml(side.tittel || side.url)}</a>
              <span class="side-path">${escapeHtml(side.url.replace(url.replace(/\/$/, ''), '') || '/')}</span>
            </div>`).join('')}
          </div>
        </div>
        ${firefoxRun ? `<div style="border:1px solid #fde68a;border-radius:4px;background:#fffbeb;padding:.8rem">
          <div style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#92400e;margin-bottom:.6rem">🦊 Firefox</div>
          <div style="font-size:.72rem;font-weight:600;color:#0a1355;margin-bottom:.5rem">🔐 Fast bruker (${escapeHtml(firefoxRun.fast.bruker ?? 'ukjent')})</div>
          <div class="sider-liste">
            ${firefoxRun.fast.sider.map(side => `<div class="side-url-rad">
              <a href="${side.url}" target="_blank">${escapeHtml(side.tittel || side.url)}</a>
              <span class="side-path">${escapeHtml(side.url.replace(url.replace(/\/$/, ''), '') || '/')}</span>
            </div>`).join('')}
          </div>
        </div>` : ''}
        ${webkitRun ? `<div style="border:1px solid #d8b4fe;border-radius:4px;background:#faf5ff;padding:.8rem">
          <div style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7e22ce;margin-bottom:.6rem">🧭 WebKit (Safari)</div>
          <div style="font-size:.72rem;font-weight:600;color:#0a1355;margin-bottom:.5rem">🔐 Fast bruker (${escapeHtml(webkitRun.fast.bruker ?? 'ukjent')})</div>
          <div class="sider-liste">
            ${webkitRun.fast.sider.map(side => `<div class="side-url-rad">
              <a href="${side.url}" target="_blank">${escapeHtml(side.tittel || side.url)}</a>
              <span class="side-path">${escapeHtml(side.url.replace(url.replace(/\/$/, ''), '') || '/')}</span>
            </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  </details>

  ${wcagSeksjonerHtml}

  <details style="margin-top:2rem;border:1px solid #e5e3de;background:white;box-shadow:0 1px 4px rgba(10,19,85,.06)">
    <summary style="cursor:pointer;padding:1rem 1.5rem;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center">
      <span>⚠️ WCAG 2.1 sjekkliste – Uutilsynet</span>
      <span style="font-size:.75rem;opacity:.5;font-weight:400;text-transform:none;letter-spacing:0">klikk for å utvide ▼</span>
    </summary>
    <div style="padding:1.2rem 1.5rem 1.5rem;border-top:1px solid #f4ecdf">
      <p style="font-size:.83rem;color:#374151;margin-bottom:1rem;line-height:1.6">
        Fullstendig dekning mot <strong>Uutilsynets WCAG 2.1-sjekkliste</strong> (48 kriterier). Automatiserte verktøy dekker ~40 % – resten krever manuell testing.
      </p>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1.2rem;font-size:.82rem">
        <span style="background:#ecfdf5;color:#07604f;padding:.25rem .8rem;border-radius:100px;font-weight:600">✅ 19 automatisk dekket</span>
        <span style="background:#f3dda2;color:#713f12;padding:.25rem .8rem;border-radius:100px;font-weight:600">⚠️ 10 delvis dekket</span>
        <span style="background:#f3f4f6;color:#374151;padding:.25rem .8rem;border-radius:100px;font-weight:600">❌ 19 ikke dekket (manuell)</span>
      </div>
      ${[
        { prinsipp: '1 – Mulig å oppfatte', rader: [
          ['1.1.1','Ikke-tekstlig innhold','A','✅','axe-core'],
          ['1.2.1','Bare lyd og bare video (forhåndsinnspilt)','A','❌','Manuell gjennomgang av media'],
          ['1.2.2','Teksting (forhåndsinnspilt)','A','❌','Manuell gjennomgang av video'],
          ['1.2.5','Synstolking (forhåndsinnspilt)','AA','❌','Manuell gjennomgang av video'],
          ['1.3.1','Informasjon og relasjoner','A','✅','axe-core (label, heading, landmark)'],
          ['1.3.2','Meningsfull rekkefølge','A','⚠️','axe-core (delvis – visuell rekkefølge ikke dekket)'],
          ['1.3.3','Sensoriske egenskaper','A','❌','Manuell vurdering'],
          ['1.3.4','Orientering','AA','✅','Egendefinert test (portrett + landskap)'],
          ['1.3.5','Identifiser formål med inndata','AA','⚠️','axe-core autocomplete-valid (delvis)'],
          ['1.4.1','Bruk av farge','A','❌','Manuell – fargebruk som eneste markør'],
          ['1.4.2','Lydkontroll','A','❌','Manuell – ingen lyd/video-innhold testet'],
          ['1.4.3','Kontrast (minimum)','AA','✅','axe-core (color-contrast)'],
          ['1.4.4','Endring av tekststørrelse','AA','⚠️','Reflow-test dekker zoom delvis; 200 % ikke sjekket'],
          ['1.4.5','Bilder av tekst','AA','❌','axe-core oppdager ikke tekst i bilder'],
          ['1.4.10','Dynamisk tilpasning (reflow)','AA','✅','Egendefinert test (320px)'],
          ['1.4.11','Kontrast for ikke-tekstlig innhold','AA','✅','axe-core (non-text-contrast)'],
          ['1.4.12','Tekstmellomrom','AA','✅','Egendefinert test (stilinjeksjon)'],
          ['1.4.13','Innhold ved pek eller fokus','AA','⚠️','Egendefinert test – title-attributter sjekket, full atferd krever manuell verifisering'],
        ]},
        { prinsipp: '2 – Mulig å betjene', rader: [
          ['2.1.1','Tastatur','A','⚠️','Egendefinert test (Tab-rekkevidden + Enter) – full funksjonstestning krever manuell sjekk'],
          ['2.1.2','Ingen tastaturfelle','A','✅','Egendefinert test'],
          ['2.1.4','Tegntaster som snarvei','A','❌','Tastatursnarveger testes ikke'],
          ['2.2.1','Justerbar tidsbegrensning','A','❌','Tidsavbrudd testes ikke'],
          ['2.2.2','Pause, stopp, skjul','A','❌','Animasjoner og bevegelig innhold testes ikke'],
          ['2.3.1','Tre glimt eller under terskel','A','❌','Blinkende innhold analyseres ikke'],
          ['2.4.1','Hoppe over blokker','A','✅','Egendefinert test (skiplink)'],
          ['2.4.2','Sidetittel','A','✅','axe-core (document-title)'],
          ['2.4.3','Fokusrekkefølge','A','⚠️','tabindex > 0 sjekkes – logisk rekkefølge i flertrinnsskjema krever manuell sjekk'],
          ['2.4.4','Formål med lenke','A','✅','axe-core (link-name)'],
          ['2.4.5','Flere måter','AA','❌','Manuell vurdering (søk, nettstedskart osv.)'],
          ['2.4.6','Overskrifter og ledetekster','AA','⚠️','axe-core (heading-order) – meningsinnhold ikke vurdert'],
          ['2.4.7','Synlig fokus','AA','✅','Egendefinert test'],
          ['2.5.1','Pekerbevegelser','A','❌','Flerfingergestuser testes ikke'],
          ['2.5.2','Avbrytelse ved pekeraktivering','A','❌','Testes ikke'],
          ['2.5.3','Ledetekst i navn','A','✅','axe-core (label-content-name-mismatch)'],
          ['2.5.4','Bevegelsesaktivering','A','❌','Testes ikke'],
        ]},
        { prinsipp: '3 – Mulig å forstå', rader: [
          ['3.1.1','Språk på siden','A','✅','axe-core (html-has-lang, html-lang-valid)'],
          ['3.1.2','Språk på deler av innhold','AA','⚠️','axe-core sjekker lang-attributt delvis'],
          ['3.2.1','Fokus','A','✅','Egendefinert test (Tab utløser ikke uventet navigasjon)'],
          ['3.2.2','Inndata','A','✅','Egendefinert test (select-endring utløser ikke uventet navigasjon)'],
          ['3.2.3','Konsekvent navigasjon','AA','❌','Manuell vurdering på tvers av sider'],
          ['3.2.4','Konsekvent identifikasjon','AA','❌','Manuell vurdering'],
          ['3.3.1','Identifikasjon av feil','A','⚠️','Egendefinert test (aria-invalid + live-regions) – dekker ikke alle feilscenarier'],
          ['3.3.2','Ledetekster og instruksjoner','A','✅','axe-core (label)'],
          ['3.3.3','Feilforslag','AA','❌','Kvalitet på feilmeldinger krever manuell vurdering'],
          ['3.3.4','Feilforebygging','AA','❌','Bekreftelse/angringsmulighet testes ikke'],
        ]},
        { prinsipp: '4 – Robust', rader: [
          ['4.1.1','Parsing','A','✅','axe-core (duplicate-id, HTML-validering)'],
          ['4.1.2','Navn, rolle, verdi','A','✅','axe-core (button-name, aria-*, frame-title)'],
          ['4.1.3','Statusmeldinger','AA','⚠️','axe-core sjekker aria-live-regioner delvis'],
        ]},
      ].map(({ prinsipp, rader }) => `
      <div style="margin-bottom:1.4rem">
        <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0a1355;padding:.4rem 0;border-bottom:2px solid #e5e3de;margin-bottom:.4rem">Prinsipp ${prinsipp}</div>
        <table style="width:100%;border-collapse:collapse;font-size:.81rem">
          <tbody>
            ${rader.map((r, i) => `
            <tr style="background:${i % 2 === 0 ? 'white' : '#fafaf9'}">
              <td style="padding:.35rem .6rem;font-family:ui-monospace,monospace;font-weight:600;color:#6b21a8;white-space:nowrap;border-bottom:1px solid #f0ece8;width:4rem">${UUTIL_URLS[r[0]] ? `<a href="${UUTIL_URLS[r[0]]}" target="_blank" rel="noopener" style="color:#6b21a8;text-decoration:none;border-bottom:1px dotted #6b21a8" title="Les om ${r[0]} på uutilsynet.no">${r[0]}</a>` : r[0]}</td>
              <td style="padding:.35rem .6rem;color:#0a1355;border-bottom:1px solid #f0ece8">${r[1]}</td>
              <td style="padding:.35rem .6rem;text-align:center;border-bottom:1px solid #f0ece8;width:2.5rem"><span style="font-size:.72rem;font-weight:700;padding:.1rem .4rem;border-radius:100px;background:${r[2]==='A'?'#dbeafe':'#e0e7ff'};color:${r[2]==='A'?'#1e40af':'#3730a3'}">${r[2]}</span></td>
              <td style="padding:.35rem .6rem;text-align:center;border-bottom:1px solid #f0ece8;width:2rem;font-size:1rem">${r[3]}</td>
              <td style="padding:.35rem .6rem;color:#6b7280;border-bottom:1px solid #f0ece8;font-size:.78rem">${r[4]}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`).join('')}
    </div>
  </details>

  <div class="seksjon" style="margin-top:2rem">
    <div class="seksjon-tittel">Slik beregnes UU-scoren</div>
    <p style="font-size:.82rem;color:#374151;margin-bottom:.9rem;line-height:1.6">
      WCAG-brudd telles per <strong>unik regeltype</strong> (ikke per side-forekomst), slik at én feil på ti sider gir samme trekk som én feil på én side. Knapper og lenker har tak på maks 15–20 poengs fradrag.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">Kritisk WCAG-regeltype (unik)</span><span style="color:#c53030;font-weight:700">× 15 poeng</span>
      <span style="color:#374151">Alvorlig WCAG-regeltype (unik)</span><span style="color:#9a3412;font-weight:700">× 8 poeng</span>
      <span style="color:#374151">Moderat WCAG-regeltype (unik)</span><span style="color:#713f12;font-weight:700">× 3 poeng</span>
      <span style="color:#374151">Mindre WCAG-regeltype (unik)</span><span style="color:#6b7280;font-weight:700">× 1 poeng</span>
      <span style="color:#374151">Død lenke (maks 20 p)</span><span style="color:#c53030;font-weight:700">× 4 poeng</span>
      <span style="color:#374151">Knapp uten label (maks 15 p)</span><span style="color:#9a3412;font-weight:700">× 2 poeng</span>
      <span style="color:#374151">Bilde uten alt-tekst (maks 10 p)</span><span style="color:#9a3412;font-weight:700">× 2 poeng</span>
      <span style="color:#374151">Skjemafelt uten label (maks 10 p)</span><span style="color:#9a3412;font-weight:700">× 2 poeng</span>
      <span style="color:#374151">Tastatur-feil (WCAG-brudd)</span><span style="color:#c53030;font-weight:700">× 10 poeng</span>
      <span style="color:#374151">Tastatur-advarsel</span><span style="color:#9a3412;font-weight:700">× 3 poeng</span>
      <span style="color:#374151">Reflow-feil (1.4.10)</span><span style="color:#c53030;font-weight:700">× 8 poeng</span>
      <span style="color:#374151">Reflow-advarsel</span><span style="color:#9a3412;font-weight:700">× 2 poeng</span>
      <span style="color:#374151">Tekstmellomrom-feil (1.4.12)</span><span style="color:#9a3412;font-weight:700">× 5 poeng</span>
      <span style="color:#374151">Ekstra WCAG-feil</span><span style="color:#c53030;font-weight:700">× 8 poeng</span>
      <span style="color:#374151">Ekstra WCAG-advarsel</span><span style="color:#9a3412;font-weight:700">× 1 poeng</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Score = maks(0, 100 − sum av trekk) &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>
  <details style="margin-top:2rem;border:1px solid #e5e3de;border-radius:.5rem;padding:1rem 1.2rem;background:#fafaf9">
    <summary style="cursor:pointer;font-size:.88rem;font-weight:600;color:#374151;user-select:none">Alle tester som kjøres ▾</summary>
    <div style="margin-top:1rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.2rem;font-size:.82rem">
      <div>
        <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem">♿ WCAG / axe-core (per side)</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
          ${['Bilder uten alt-tekst (1.1.1)','Fargekontrast (1.4.3, 1.4.11)','Skjemafelt uten label (1.3.1)','Knapper uten tilgjengelig navn (4.1.2)','Overskriftshierarki (1.3.1)','Landmarks og regionstruktur (1.3.6)','Lenker uten forståelig tekst (2.4.4)','ARIA-roller og -attributter','Sidespråk (3.1.1)','Fokusmarkering (2.4.7)','Tittel på siden (2.4.2)','… og øvrige axe-core-regler (90+)'].map(n => `<li style="color:#374151">· ${n}</li>`).join('')}
        </ul>
      </div>
      <div>
        <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem">🔗 Lenker</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
          ${['Døde lenker (HTTP-statuskode)','Lenker uten synlig tekst'].map(n => `<li style="color:#374151">· ${n}</li>`).join('')}
        </ul>
        <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem;margin-top:1rem">⌨️ Tastaturnavigasjon</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
          ${tastatur.tester.map(t => `<li style="color:#374151">· ${t.navn} <span style="color:#9ca3af;font-size:.75rem">(WCAG ${t.wcag})</span></li>`).join('')}
        </ul>
      </div>
      <div>
        <div style="font-weight:600;color:#0a1355;margin-bottom:.4rem">📱 Reflow (1.4.10) · 📐 Tekstmellomrom (1.4.12)</div>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem">
          ${[...reflow.tester, ...tekstmellomrom.tester].map(t => `<li style="color:#374151">· ${t.navn} <span style="color:#9ca3af;font-size:.75rem">(WCAG ${t.wcag})</span></li>`).join('')}
        </ul>
      </div>
    </div>
  </details>
  <footer>KS Tilskudd · UU-tester · axe-core + Playwright · ${dato} ${tidspunkt}</footer>
</div>
</body>
</html>`;
}
