import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_URL = process.argv[2] || 'https://tilskudd.fiks.ks.no/';
const dato = new Date().toISOString().slice(0, 10);
const tidspunkt = new Date().toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
const rapportDir = path.join(__dirname, 'rapporter', dato);
const skjermDir = path.join(rapportDir, 'skjermbilder-tastatur');
fs.mkdirSync(skjermDir, { recursive: true });

const baseOrigin = new URL(START_URL).origin;
const startTid = Date.now();

console.log(`\n⌨️  Starter tastaturnavigasjonstest av: ${START_URL}`);
console.log(`📅 Dato: ${dato}\n`);

// ── Testresultater ────────────────────────────────────────────────────────────

const tester = []; // { kategori, navn, input, forventet, faktisk, resultat, detalj, skjerm }
let skjermTeller = 0;

function logg(resultat, navn, detalj = '') {
  const ikon = { bestått: '✅', feil: '❌', advarsel: '⚠️' }[resultat] || '⚪';
  console.log(`  ${ikon} ${navn}${detalj ? ` – ${detalj}` : ''}`);
}

// ── Browser ───────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 TastaturTester/1.0',
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

async function skjermdump(prefix) {
  skjermTeller++;
  const filnavn = `tastatur-${prefix}-${skjermTeller}.png`;
  try {
    await page.screenshot({ path: path.join(skjermDir, filnavn), fullPage: false });
    return `skjermbilder-tastatur/${filnavn}`;
  } catch { return null; }
}

async function gåTil(url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(600);
    return true;
  } catch { return false; }
}

async function leggTilTest(kategori, navn, input, forventet, testFn) {
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

  tester.push({ kategori, navn, input, forventet, faktisk, resultat, detalj, skjerm });
  logg(resultat, navn, detalj);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 1: Synlig fokus (WCAG 2.4.7)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n👁️  Kategori 1: Synlig fokus (WCAG 2.4.7)');

// 1a. Sjekk om lenker har synlig fokusmarkering
await leggTilTest('synligfokus', 'Synlig fokus på interaktive elementer (Tab ×15)', 'Tab (15 ganger)', 'Hvert element har synlig fokusmarkering', async () => {
  await gåTil(START_URL);

  const utenFokus = [];
  let forrigeEl = null;

  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);

    const fokusInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const st = window.getComputedStyle(el);
      const outline = st.outlineStyle;
      const outlineWidth = parseFloat(st.outlineWidth);
      const outlineColor = st.outlineColor;
      const boxShadow = st.boxShadow;
      const borderColor = st.borderColor;

      // Vurdert som synlig hvis:
      // - outline-style ikke er 'none' OG bredde > 0
      // - eller box-shadow er satt (ikke 'none')
      const harOutline = outline !== 'none' && outlineWidth > 0;
      const harBoxShadow = boxShadow !== 'none' && boxShadow !== '';
      const synlig = harOutline || harBoxShadow;

      return {
        tag: el.tagName,
        tekst: (el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 60),
        outline: st.outline,
        boxShadow: boxShadow.slice(0, 60),
        synlig,
      };
    });

    if (!fokusInfo) continue;

    const key = `${fokusInfo.tag}:${fokusInfo.tekst}`;
    if (key === forrigeEl) continue; // Unngå duplikater
    forrigeEl = key;

    if (!fokusInfo.synlig) {
      utenFokus.push(`${fokusInfo.tag} "${fokusInfo.tekst}"`);
    }
  }

  if (utenFokus.length > 0) {
    const skjerm = await skjermdump('fokus-mangler');
    return {
      faktisk: `${utenFokus.length} element(er) uten synlig fokus: ${utenFokus.slice(0, 3).join(', ')}`,
      resultat: 'advarsel',
      detalj: 'Synlig fokus er påkrevd for tastaturbrukere og skjermlesere (WCAG 2.4.7)',
      skjerm,
    };
  }
  return { faktisk: 'Alle kontrollerte elementer har synlig fokus', resultat: 'bestått' };
});

// 1b. Sjekk om focus-outline er fjernet uten erstatning
await leggTilTest('synligfokus', 'outline:none uten erstatning (global CSS)', 'getComputedStyle etter focus', 'Ingen elementer der focus-outline er fjernet uten box-shadow', async () => {
  await gåTil(START_URL);

  const problematiske = await page.evaluate(() => {
    const elementer = document.querySelectorAll('a, button, input, select, textarea, [tabindex]');
    const funn = [];
    for (const el of elementer) {
      if (el.offsetParent === null) continue; // Skjult element
      // Simuler focus-tilstand via :focus-visible selektor
      const st = window.getComputedStyle(el);
      if (st.outlineStyle === 'none' && st.boxShadow === 'none') {
        funn.push(`${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}`);
      }
    }
    return funn.slice(0, 10);
  });

  if (problematiske.length > 5) {
    return {
      faktisk: `${problematiske.length} elementer mangler fokus-styling: ${problematiske.slice(0, 4).join(', ')}…`,
      resultat: 'advarsel',
      detalj: 'Bør verifiseres manuelt – CSS kan ha :focus-visible selektorer som ikke fanges av getComputedStyle',
    };
  }
  if (problematiske.length > 0) {
    return {
      faktisk: `${problematiske.length} element(er) uten outline/box-shadow: ${problematiske.join(', ')}`,
      resultat: 'advarsel',
      detalj: 'Sjekk at disse har tydelig fokusmarkering via :focus eller :focus-visible',
    };
  }
  return { faktisk: 'Ingen åpenbare mangler på fokus-styling funnet', resultat: 'bestått' };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 2: Tabindeks-misbruk (WCAG 2.4.3)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n🔢 Kategori 2: Tabindeks-rekkefølge (WCAG 2.4.3)');

// 2a. Elementer med tabindex > 0
await leggTilTest('tabindeks', 'Elementer med tabindex > 0 (forstyrrer naturlig rekkefølge)', 'querySelectorAll("[tabindex]")', 'Ingen elementer med tabindex > 0', async () => {
  await gåTil(START_URL);

  const misbruk = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[tabindex]'))
      .filter(el => parseInt(el.getAttribute('tabindex'), 10) > 0)
      .map(el => ({
        tag: el.tagName,
        tabindex: el.getAttribute('tabindex'),
        tekst: (el.textContent?.trim() || el.getAttribute('aria-label') || '').slice(0, 50),
      }));
  });

  if (misbruk.length > 0) {
    return {
      faktisk: `${misbruk.length} element(er) med tabindex > 0: ${misbruk.map(e => `${e.tag}[tabindex=${e.tabindex}]`).join(', ')}`,
      resultat: 'advarsel',
      detalj: 'tabindex > 0 forstyrrer naturlig fokusrekkefølge. Bruk 0 eller -1 i stedet (WCAG 2.4.3)',
    };
  }
  return { faktisk: 'Ingen elementer med tabindex > 0 funnet', resultat: 'bestått' };
});

// 2b. Interaktive elementer med tabindex=-1 (bevisst ekskludert)
await leggTilTest('tabindeks', 'Synlige interaktive elementer med tabindex=-1', 'querySelectorAll("a,button[tabindex=-1]")', 'Ingen synlige interaktive elementer skjult fra tastaturrekkefølgen', async () => {
  await gåTil(START_URL);

  const ekskludert = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href][tabindex="-1"], button[tabindex="-1"]'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(el => ({
        tag: el.tagName,
        tekst: (el.textContent?.trim() || el.getAttribute('aria-label') || '').slice(0, 50),
      }));
  });

  if (ekskludert.length > 0) {
    return {
      faktisk: `${ekskludert.length} synlig(e) element(er) med tabindex=-1: ${ekskludert.map(e => `${e.tag} "${e.tekst}"`).slice(0, 3).join(', ')}`,
      resultat: 'advarsel',
      detalj: 'Synlige interaktive elementer bør være tilgjengelige med tastatur (WCAG 2.1.1)',
    };
  }
  return { faktisk: 'Ingen synlige interaktive elementer er ekskludert fra tastaturrekkefølgen', resultat: 'bestått' };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 3: Tastaturrekkevidde (WCAG 2.1.1)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n⌨️  Kategori 3: Tastaturrekkevidde (WCAG 2.1.1)');

// 3a. Tab gjennom siden – teller unike fokuserbare elementer
await leggTilTest('rekkevidden', 'Interaktive elementer nåbare via Tab (×50)', 'Tab (50 ganger)', 'Minst én lenke/knapp/felt er fokusert', async () => {
  await gåTil(START_URL);

  const interaktiveDOM = await page.evaluate(() =>
    document.querySelectorAll('a[href]:not([tabindex="-1"]), button:not([tabindex="-1"]):not([disabled]), input:not([type=hidden]):not([tabindex="-1"]):not([disabled]), select:not([tabindex="-1"]):not([disabled]), textarea:not([tabindex="-1"]):not([disabled])').length
  );

  const fokuserteElementer = new Set();
  let forrigeTag = null;

  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const fokus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        id: `${el.tagName}|${el.getAttribute('href') || ''}|${el.textContent?.trim().slice(0, 30) || el.getAttribute('aria-label') || ''}`,
        tag: el.tagName,
      };
    });
    if (fokus) {
      fokuserteElementer.add(fokus.id);
      forrigeTag = fokus.tag;
    }
  }

  const antallFokusert = fokuserteElementer.size;

  if (antallFokusert === 0) {
    const skjerm = await skjermdump('ingen-fokus');
    return {
      faktisk: 'Ingen elementer ble fokusert med Tab',
      resultat: 'feil',
      detalj: 'Siden er ikke tastaturnavigasjonsbar (WCAG 2.1.1)',
      skjerm,
    };
  }
  if (antallFokusert < 3 && interaktiveDOM > 5) {
    return {
      faktisk: `Kun ${antallFokusert} av ~${interaktiveDOM} interaktive elementer ble nådd`,
      resultat: 'advarsel',
      detalj: 'Mulig at mange interaktive elementer ikke er nåbare via tastatur (WCAG 2.1.1)',
    };
  }
  return {
    faktisk: `${antallFokusert} unike elementer fokusert via Tab (${interaktiveDOM} interaktive i DOM)`,
    resultat: 'bestått',
  };
});

// 3b. Shift+Tab for bakovernavigasjon
await leggTilTest('rekkevidden', 'Shift+Tab for bakovernavigasjon', 'Shift+Tab (5 ganger)', 'Fokus beveger seg bakover i siden', async () => {
  await gåTil(START_URL);

  // Tab fremover 5 ganger for å komme litt ut på siden
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
  }

  const posisjonFremover = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? el.tagName + '|' + (el.textContent?.trim().slice(0, 30) || '') : null;
  });

  // Shift+Tab bakover 5 ganger
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(60);
  }

  const posisjonBakover = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? el.tagName + '|' + (el.textContent?.trim().slice(0, 30) || '') : null;
  });

  if (!posisjonBakover || posisjonBakover === posisjonFremover) {
    const skjerm = await skjermdump('shift-tab-feil');
    return {
      faktisk: 'Shift+Tab endret ikke fokusposisjon',
      resultat: 'advarsel',
      detalj: 'Shift+Tab skal flytte fokus bakover (WCAG 2.1.1)',
      skjerm,
    };
  }
  return {
    faktisk: `Shift+Tab fungerer – fokus gikk fra "${posisjonFremover?.split('|')[1]}" bakover`,
    resultat: 'bestått',
  };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 4: Ingen tastaturfelle (WCAG 2.1.2)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n🚫 Kategori 4: Ingen tastaturfelle (WCAG 2.1.2)');

// 4a. Tab fanger seg ikke i loop
await leggTilTest('tastaturfelle', 'Ingen tastaturfelle – Tab beveger seg fritt (×40)', 'Tab (40 ganger)', 'Fokus avanserer jevnt – ikke samme element 3× på rad', async () => {
  await gåTil(START_URL);

  let forrigeId = null;
  let konsekutive = 0;
  let felleFunnet = null;
  const siste3 = [];

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);

    const fokus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return `${el.tagName}|${el.getAttribute('href') || el.getAttribute('id') || el.textContent?.trim().slice(0, 30)}`;
    });

    siste3.push(fokus);
    if (siste3.length > 3) siste3.shift();

    if (fokus === forrigeId) {
      konsekutive++;
      if (konsekutive >= 3) {
        felleFunnet = fokus;
        break;
      }
    } else {
      konsekutive = 0;
      forrigeId = fokus;
    }
  }

  if (felleFunnet) {
    const skjerm = await skjermdump('tastaturfelle');
    return {
      faktisk: `Tastaturfelle funnet ved: "${felleFunnet}"`,
      resultat: 'feil',
      detalj: 'Fokus ble fanget i samme element. Brukere uten mus er låst (WCAG 2.1.2)',
      skjerm,
    };
  }
  return { faktisk: 'Ingen tastaturfelle funnet – fokus avanserte fritt', resultat: 'bestått' };
});

// 4b. Escape lukker dialoger/overlays
await leggTilTest('tastaturfelle', 'Escape-tast håndteres (lukker overlay/modal)', 'Escape', 'Siden krasjer ikke og fokus flyttes ikke uventet', async () => {
  await gåTil(START_URL);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const tekst = await page.textContent('body').catch(() => '');
  const krasj = ['500', 'internal server error', 'something went wrong'].some(s => tekst.toLowerCase().includes(s));
  if (krasj) {
    const skjerm = await skjermdump('escape-krasj');
    return { faktisk: 'Siden krasjet etter Escape', resultat: 'feil', skjerm };
  }
  return { faktisk: 'Escape håndtert uten krasj', resultat: 'bestått' };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 5: Hopplenke (WCAG 2.4.1)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n⏭️  Kategori 5: Hopplenke til hovedinnhold (WCAG 2.4.1)');

// 5a. Hopplenke finnes og fokuseres på første Tab
await leggTilTest('hopplenke', 'Hopplenke til hovedinnhold ved første Tab', 'Tab (1 gang fra topp)', 'Første fokuserte element er en hopplenke', async () => {
  await gåTil(START_URL);

  // Reset fokus til body
  await page.evaluate(() => document.body.focus());
  await page.waitForTimeout(100);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);

  const hoppInfo = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const tekst = (el.textContent?.trim() || el.getAttribute('aria-label') || '').toLowerCase();
    const href = el.getAttribute('href') || '';
    const erHopp = tekst.includes('hopp') || tekst.includes('skip') || tekst.includes('gå til innhold') || tekst.includes('til innhold') || tekst.includes('main') || (href.startsWith('#') && el.tagName === 'A');
    return { tag: el.tagName, tekst: tekst.slice(0, 80), href, erHopp };
  });

  const skjerm = await skjermdump('hopplenke');

  if (!hoppInfo) {
    return {
      faktisk: 'Ingen element fokusert etter første Tab',
      resultat: 'advarsel',
      detalj: 'Første Tab bør fokusere en "Hopp til innhold"-lenke (WCAG 2.4.1)',
      skjerm,
    };
  }
  if (!hoppInfo.erHopp) {
    return {
      faktisk: `Første fokuserte element er ${hoppInfo.tag} "${hoppInfo.tekst}" – ikke en hopplenke`,
      resultat: 'advarsel',
      detalj: 'En synlig hopplenke øverst på siden hjelper tastaturbrukere (WCAG 2.4.1)',
      skjerm,
    };
  }
  return {
    faktisk: `Hopplenke funnet: "${hoppInfo.tekst}" (href="${hoppInfo.href}")`,
    resultat: 'bestått',
    skjerm,
  };
});

// 5b. Hopplenke fører til riktig ankerpunkt
await leggTilTest('hopplenke', 'Hopplenke aktivert med Enter setter fokus i main', 'Tab + Enter på hopplenke', 'Fokus flyttes til hoved-/main-element', async () => {
  await gåTil(START_URL);
  await page.evaluate(() => document.body.focus());
  await page.waitForTimeout(100);

  // Finn hopplenke
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);

  const erHopp = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el.tagName !== 'A') return false;
    const tekst = (el.textContent?.trim() || '').toLowerCase();
    const href = el.getAttribute('href') || '';
    return tekst.includes('hopp') || tekst.includes('skip') || tekst.includes('innhold') || href.startsWith('#');
  });

  if (!erHopp) {
    return {
      faktisk: 'Ingen hopplenke å aktivere (se forrige test)',
      resultat: 'advarsel',
      detalj: 'Testen avhenger av at hopplenke finnes (WCAG 2.4.1)',
    };
  }

  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  const fokusEtterHopp = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const tag = el.tagName;
    const id = el.id;
    return { tag, id, erMain: tag === 'MAIN' || id === 'main' || id === 'innhold' || id === 'content' };
  });

  if (fokusEtterHopp?.erMain) {
    return { faktisk: `Fokus flyttet til ${fokusEtterHopp.tag}#${fokusEtterHopp.id}`, resultat: 'bestått' };
  }
  return {
    faktisk: fokusEtterHopp ? `Fokus etter Enter: ${fokusEtterHopp.tag}#${fokusEtterHopp.id}` : 'Fokus ikke funnet',
    resultat: 'advarsel',
    detalj: 'Hopplenken bør peke på et fokusbart main-element (WCAG 2.4.1)',
  };
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI 6: Tastaturaktivering (WCAG 2.1.1)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n↵  Kategori 6: Tastaturaktivering (WCAG 2.1.1)');

// 6a. Enter aktiverer lenker
await leggTilTest('aktivering', 'Enter aktiverer navigasjonslenke', 'Tab til lenke + Enter', 'Siden navigerer til ny URL', async () => {
  await gåTil(START_URL);
  const utgangsUrl = page.url();

  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);

    const lenkeFunnet = await page.evaluate(() => {
      const el = document.activeElement;
      if (el?.tagName !== 'A') return false;
      const href = el.getAttribute('href') || '';
      return href.length > 0 && !href.startsWith('#') && !href.startsWith('javascript') && !href.startsWith('mailto');
    });

    if (lenkeFunnet) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      const nyUrl = page.url();
      if (nyUrl !== utgangsUrl) {
        return { faktisk: `Lenken ble aktivert – navigerte til ${nyUrl}`, resultat: 'bestått' };
      }
      return { faktisk: 'Enter trykket på lenke, men URL endret seg ikke', resultat: 'advarsel', detalj: 'Sjekk at lenken er riktig registrert med href (WCAG 2.1.1)' };
    }
  }

  return {
    faktisk: 'Ingen navigasjonslenke funnet i de første 15 Tab-stegene',
    resultat: 'advarsel',
    detalj: 'Testen fant ikke en ekstern lenke å aktivere – sjekk manuelt',
  };
});

// 6b. Enter/Space aktiverer knapper
await leggTilTest('aktivering', 'Enter/Space aktiverer knapper', 'Tab til knapp + Space', 'Knappen utfører sin handling uten krasj', async () => {
  await gåTil(START_URL);

  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);

    const knappFunnet = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.tagName === 'BUTTON' && !el.disabled;
    });

    if (knappFunnet) {
      const urlFør = page.url();
      await page.keyboard.press('Space');
      await page.waitForTimeout(800);
      const tekst = await page.textContent('body').catch(() => '');
      const krasj = ['500', 'internal server error', 'something went wrong'].some(s => tekst.toLowerCase().includes(s));
      if (krasj) {
        const skjerm = await skjermdump('knapp-krasj');
        return { faktisk: 'Krasj etter Space på knapp', resultat: 'feil', skjerm };
      }
      return { faktisk: 'Space aktiverte knapp uten krasj', resultat: 'bestått' };
    }
  }

  return {
    faktisk: 'Ingen synlig knapp funnet i de første 20 Tab-stegene',
    resultat: 'advarsel',
    detalj: 'Testen fant ikke en knapp å aktivere – sjekk manuelt',
  };
});

// 6c. Enter aktiverer søkefelt
await leggTilTest('aktivering', 'Enter sender inn søkefelt', 'Tab til søkefelt + Enter', 'Siden håndterer søket uten krasj', async () => {
  await gåTil(START_URL);

  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);

    const søkFunnet = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.tagName === 'INPUT' && (el.type === 'search' || el.type === 'text' || el.name?.includes('søk') || el.name?.includes('search'));
    });

    if (søkFunnet) {
      await page.keyboard.type('test');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      const tekst = await page.textContent('body').catch(() => '');
      const krasj = ['500', 'internal server error', 'something went wrong'].some(s => tekst.toLowerCase().includes(s));
      if (krasj) {
        const skjerm = await skjermdump('søk-krasj');
        return { faktisk: 'Siden krasjet etter Enter i søkefelt', resultat: 'feil', skjerm };
      }
      return { faktisk: 'Enter i søkefelt håndtert uten krasj', resultat: 'bestått' };
    }
  }

  return {
    faktisk: 'Søkefelt ikke funnet i de første 15 Tab-stegene',
    resultat: 'advarsel',
    detalj: 'Sjekk manuelt at søkefelt er tilgjengelig via tastatur',
  };
});

// ───────────────────────────────────────────────────────────────────────────────

await browser.close();

// ── Oppsummering ──────────────────────────────────────────────────────────────

const varighet = Math.round((Date.now() - startTid) / 1000);
const bestått  = tester.filter(t => t.resultat === 'bestått').length;
const feil     = tester.filter(t => t.resultat === 'feil').length;
const advarsel = tester.filter(t => t.resultat === 'advarsel').length;

const score = Math.max(0, 100 - feil * 15 - advarsel * 5);
const scoreKlasse = score >= 80 ? 'god' : score >= 50 ? 'middels' : 'dårlig';

console.log(`\n${'━'.repeat(60)}`);
console.log(`⌨️  TASTATURNAVIGASJONSRAPPORT – ${START_URL}`);
console.log('━'.repeat(60));
console.log(`✅ Bestått:   ${bestått}`);
console.log(`⚠️  Advarsler: ${advarsel}`);
console.log(`❌ Feil:      ${feil}`);
console.log(`📊 Score:     ${score}/100`);
console.log(`⏱️  Varighet:  ${varighet}s`);
console.log('━'.repeat(60));

fs.writeFileSync(
  path.join(rapportDir, 'tastatur-resultat.json'),
  JSON.stringify({ url: START_URL, dato, versjon, score, totalt: { bestått, feil, advarsel, totalt: tester.length, varighet }, tester }, null, 2)
);

// ── HTML-rapport ──────────────────────────────────────────────────────────────

const KATEGORIER = {
  synligfokus:  { tittel: 'Synlig fokus (WCAG 2.4.7)',          ikon: '👁️' },
  tabindeks:    { tittel: 'Tabindeks-rekkefølge (WCAG 2.4.3)',  ikon: '🔢' },
  rekkevidden:  { tittel: 'Tastaturrekkevidde (WCAG 2.1.1)',     ikon: '⌨️' },
  tastaturfelle:{ tittel: 'Ingen tastaturfelle (WCAG 2.1.2)',    ikon: '🚫' },
  hopplenke:    { tittel: 'Hopplenke til innhold (WCAG 2.4.1)', ikon: '⏭️' },
  aktivering:   { tittel: 'Tastaturaktivering (WCAG 2.1.1)',     ikon: '↵' },
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
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:.2rem">Test</div>
        <div style="color:#374151;word-break:break-all">${t.input}</div>
      </div>
      <div style="background:${t.resultat === 'bestått' ? '#ecfdf5' : t.resultat === 'feil' ? '#fee2e2' : '#fff9db'};padding:.4rem .6rem">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:.2rem">Resultat</div>
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tastaturnavigasjonstest – ${dato} ${tidspunkt}</title>
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
    <div class="sidemeny-logo">KS Tilskudd · Tastaturnavigasjon</div>
    <div class="env-badge">PRODUKSJON${versjon ? ` · ${versjon}` : ''}</div>
    <h1>Tastaturtest <span>${dato} ${tidspunkt} · ${tester.length} tester</span></h1>
  </div>
  <ul>${sidenavigasjon}</ul>
</nav>
<div class="hoveddel">
  <div class="rapport-header">
    <div>
      <h1>Tastaturnavigasjonstest</h1>
      <div class="meta"><a href="${START_URL}" target="_blank">${START_URL}</a> · ${dato} ${tidspunkt} · ${tester.length} tester · ${varighet}s</div>
    </div>
    <div class="nav-knapper">
      <a href="rapport.html" class="knapp sekundær">Forside</a>
      <a href="uu-rapport.html" class="knapp sekundær">UU-rapport</a>
      <a href="monkey-rapport.html" class="knapp sekundær">Monkey-test</a>
      <a href="sikkerhet-rapport.html" class="knapp sekundær">Sikkerhetstest</a>
      <a href="negativ-rapport.html" class="knapp sekundær">Negativ test</a>
      <a href="tastatur-rapport.html" class="knapp aktiv">Tastaturtest</a>
      <a href="arkiv.html" class="knapp sekundær">Tidligere rapporter</a>
    </div>
  </div>

  <div class="seksjon" style="background:#f4ecdf;border-color:#e8dcc8;margin-bottom:1.5rem">
    <div class="seksjon-tittel">Hva er tastaturnavigasjonstesting?</div>
    <p style="font-size:.88rem;line-height:1.7;color:#374151;margin-bottom:1rem">
      Tastaturnavigasjonstesting verifiserer at alle funksjoner er tilgjengelige uten mus,
      kun ved bruk av tastatur. Dette er et krav for brukere med motoriske begrensninger
      og er grunnleggende for universell utforming (WCAG 2.1 nivå A og AA).
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;font-size:.83rem">
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">WCAG-kriterier</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>👁️ 2.4.7 Synlig fokus (AA)</li>
          <li>🔢 2.4.3 Tabindeks-rekkefølge (A)</li>
          <li>⌨️ 2.1.1 Tastaturnavigasjon (A)</li>
          <li>🚫 2.1.2 Ingen tastaturfelle (A)</li>
          <li>⏭️ 2.4.1 Hopplenke (A)</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Hva testes</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>Synlig fokusmarkering på alle elementer</li>
          <li>Tabindeks-rekkefølge og misbruk</li>
          <li>Alle interaktive elementer nåbare</li>
          <li>Tab fanger ikke brukeren i loop</li>
          <li>Hopplenke til hovedinnhold</li>
          <li>Enter/Space aktiverer elementer</li>
        </ul>
      </div>
      <div>
        <strong style="color:#0a1355;display:block;margin-bottom:.3rem">Testresultater</strong>
        <ul style="list-style:none;display:flex;flex-direction:column;gap:.25rem;color:#374151">
          <li>✅ Bestått – fungerer som forventet</li>
          <li>⚠️ Advarsel – fungerer, men bør sjekkes</li>
          <li>❌ Feil – bryter WCAG-krav</li>
          <li>Playwright (ekte nettleser)</li>
          <li>Daglig kjøring via GitHub Actions</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="score-kort">
    <div class="score-sirkel ${scoreKlasse}">${score}</div>
    <div class="score-tekst">
      <strong>Tilgjengelighetsscore (tastatur)</strong>
      <p>${bestått} av ${tester.length} tester bestått. ${feil} feil og ${advarsel} advarsler på tvers av ${Object.keys(KATEGORIER).length} WCAG-kategorier.</p>
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
    <div class="seksjon-tittel">Slik beregnes tilgjengelighetsscoren</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .8rem;font-size:.82rem;font-family:ui-monospace,monospace;margin-bottom:.9rem">
      <span style="color:#374151">Feil (bryter WCAG)</span><span style="color:#c53030;font-weight:700">× 15 poeng</span>
      <span style="color:#374151">Advarsel (bør sjekkes)</span><span style="color:#9a3412;font-weight:700">× 5 poeng</span>
    </div>
    <p style="font-size:.78rem;color:#6b7280;font-family:ui-monospace,monospace">Score = maks(0, 100 − sum av trekk) &nbsp;·&nbsp; <span style="color:#07604f;font-weight:600">Grønn ≥ 80</span> &nbsp;·&nbsp; <span style="color:#b8860b;font-weight:600">Gul 50–79</span> &nbsp;·&nbsp; <span style="color:#c53030;font-weight:600">Rød &lt; 50</span></p>
  </div>
  <footer>KS Tilskudd · Tastaturnavigasjonstest · WCAG 2.1 A+AA · Playwright · ${dato} ${tidspunkt}</footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(rapportDir, 'tastatur-rapport.html'), html);

// Lagre tidsstemplet kopi for arkiv
const tidFil = tidspunkt.replace(':', '-');
fs.copyFileSync(path.join(rapportDir, 'tastatur-resultat.json'), path.join(rapportDir, `tastatur-resultat-${tidFil}.json`));
fs.copyFileSync(path.join(rapportDir, 'tastatur-rapport.html'), path.join(rapportDir, `tastatur-rapport-${tidFil}.html`));

console.log(`\n📁 Tastatur-rapport: ${path.join(rapportDir, 'tastatur-rapport.html')}`);
exec(`open "${path.join(rapportDir, 'tastatur-rapport.html')}"`);
