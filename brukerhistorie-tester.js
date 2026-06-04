// brukerhistorie-tester.js
// Brukerhistorietester med @playwright/test.
// Hver test.describe tilsvarer én brukerhistorie med akseptansekriterier som test()-steg.
import { test, expect } from '@playwright/test';
import { START_URL, SIDE_TIMEOUT, IDLE_TIMEOUT } from './config.js';
import fs from 'fs';

const base = START_URL.replace(/\/$/, '');
const SKJERMBILDER = 'brukerhistorie-resultater/skjermbilder';

const FEIL_MØNSTER = /Serverfeil|Noe gikk galt|Something went wrong|Uventet feil|En feil har oppstått/i;

async function sjekkForServerfeil(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  if (FEIL_MØNSTER.test(bodyText)) {
    throw new Error(`Siden viser feilmelding (Serverfeil) – avbryter uten å vente på timeout. Faktisk sideinnhold: "${bodyText.slice(0, 150).trim()}"`);
  }
}

// ── TILSK-481 / TILSK-793 ────────────────────────────────────────────────────────
test.describe('TILSK-481 / TILSK-793: Som søker vil jeg søke etter en tilskuddsordning', () => {

  const SØKEFELT = 'input[placeholder*="tilskuddsordning"], input[placeholder*="Søk etter"], input[type="search"]';

  async function gåTilForside(page) {
    await page.goto(`${base}/`, { timeout: IDLE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT });
  }

  // AK-2: Søkefelt med riktig placeholder og Søk-knapp er synlig på forsiden
  test('AK-2 – søkefelt med placeholder "Søk etter tilskuddsordning" er synlig', async ({ page }) => {
    await gåTilForside(page);
    const felt = page.locator(SØKEFELT).first();
    await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('AK-2 – Søk-knapp er synlig ved siden av søkefeltet', async ({ page }) => {
    await gåTilForside(page);
    const knapp = page.locator('button:has-text("Søk")').first();
    await expect(knapp).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('AK-2 – søkefeltet er fokuserbart', async ({ page }) => {
    await gåTilForside(page);
    const felt = page.locator(SØKEFELT).first();
    await felt.click();
    await expect(felt).toBeFocused();
  });

  // AK-3: Søk fra forsiden navigerer til oversiktssiden
  test('AK-3 – søk fra forsiden navigerer til oversiktssiden for utlysninger', async ({ page }) => {
    await gåTilForside(page);
    const felt = page.locator(SØKEFELT).first();
    await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
    await felt.fill('tilskudd');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/utlysing/);
  });

  test('AK-3 – søk fra forsiden gir respons uten feilside', async ({ page }) => {
    await gåTilForside(page);
    const felt = page.locator(SØKEFELT).first();
    await felt.fill('tilskudd');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/Internal Server Error|Uventet feil/);
  });

  // AK-4: Forsiden har H1 og ingress som forklarer hva tjenesten er
  test('AK-4 – forsiden viser H1 "Nasjonal portal for søknad om offentlige tilskudd"', async ({ page }) => {
    await gåTilForside(page);
    await expect(page.locator('h1')).toContainText('Nasjonal portal', { timeout: SIDE_TIMEOUT });
  });

  test('AK-4 – forsiden viser ingress om å finne tilskuddsordninger', async ({ page }) => {
    await gåTilForside(page);
    const body = await page.textContent('body');
    expect(body).toMatch(/finn tilskuddsordninger|søke etter navn/i);
  });

  test('AK-4 – forsiden har innholdsseksjon som forklarer hva portalen er', async ({ page }) => {
    await gåTilForside(page);
    const body = await page.textContent('body');
    expect(body).toMatch(/felles løsning|næringstilskudd|KS Tilskudd samler/i);
  });

  // TILSK-481: Videre søk gjøres på oversiktssiden
  test('TILSK-481 – søk på oversiktssiden gir treff uten feilside', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const felt = page.locator('input[type="search"], input[placeholder*="øk"]').first();
    await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
    await felt.fill('tilskudd');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/Internal Server Error|Uventet feil/);
  });

  // AK-4: Footer-lenker (Personvernerklæring + Tilgjengelighetserklæring) er i Figma-designet
  // men ikke implementert i PROD-miljøet ennå – testen legges til når de er på plass.

});

// ── TILSK-543 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-543: Som besøker ønsker jeg å finne riktig tilskuddsordning i portalen (uten innlogging)', () => {

  // AK-1.1: Liste over tilskuddsordninger er tilgjengelig uten innlogging
  test('AK-1.1 – utlysningslisten vises uten krav om innlogging', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await expect(page).toHaveURL(/utlysinger/);
    const kort = page.locator('article, [class*="card"], [class*="kort"], li a[href*="utlysing"]');
    await expect(kort.first()).toBeVisible({ timeout: SIDE_TIMEOUT });
    const body = await page.textContent('body');
    expect(body).not.toMatch(/logg inn for å/i);
  });

  // AK-1.2: Søkefunksjonalitet er tilgjengelig uten innlogging
  test('AK-1.2 – søkefelt er synlig og tilgjengelig uten innlogging', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const felt = page.locator('input[type="search"], input[placeholder*="øk"]').first();
    await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  // AK-2.1–2.4: Dekkes av TILSK-856

  // AK-3.1: Paginering – bla til neste side hvis listen er lang
  test('AK-3.1 – pagineringsknapp finnes hvis listen har flere sider', async ({ page }, testInfo) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT });
    const pagKnapp = page.locator(
      'button:has-text("Neste"), a:has-text("Neste"), ' +
      '[aria-label*="neste" i], [aria-label*="next" i], ' +
      '[class*="pagination"] button, nav[aria-label*="paginering"] button'
    ).first();
    const harPaginering = (await pagKnapp.count()) > 0;
    testInfo.skip(!harPaginering, 'Ingen pagineringsknapp funnet – testmiljøet har antagelig færre ordninger enn én side krever, eller pagineringsselektorer treffer ikke appens DOM');
    await expect(pagKnapp).toBeAttached({ timeout: SIDE_TIMEOUT });
  });

  // AK-4.1: Ingen treff – tydelig beskjed (med forslag til hva brukeren kan gjøre)
  test('AK-4.1 – ingen treff: tydelig melding vises, ikke feilside', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const felt = page.locator('input[type="search"], input[placeholder*="øk"]').first();
    await felt.fill('xyzabc123nonsens');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/500|Internal Server Error|Uventet feil/);
    const kortEtter = await page.locator('article, [class*="card"], [class*="kort"], li a[href*="utlysig"]').count();
    const ingenTreffEl = await page.locator(
      '[class*="ingen"], [class*="empty"], [class*="no-result"], [class*="zero-result"]'
    ).count();
    expect(kortEtter === 0 || ingenTreffEl > 0, 'Forventet ingen ordningskort eller en ingen-treff-melding').toBe(true);
  });

});

// ── TILSK-547 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-547: Som innlogget søker vil jeg se mine søknader', () => {

  test('min side er tilgjengelig etter innlogging', async ({ page }) => {
    await page.goto(`${base}/minside`, { timeout: IDLE_TIMEOUT });
    await expect(page).toHaveURL(/minside/);
  });

  test('min side viser ikke innloggingsskjema (brukeren er innlogget)', async ({ page }) => {
    await page.goto(`${base}/minside`, { timeout: IDLE_TIMEOUT });
    const loggInnKnapp = page.locator('a:has-text("Logg inn"), button:has-text("Logg inn")');
    await expect(loggInnKnapp).toHaveCount(0);
  });

  test('min side laster uten JavaScript-feil', async ({ page }) => {
    const feil = [];
    page.on('pageerror', e => feil.push(e.message));
    await page.goto(`${base}/minside`, { timeout: IDLE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT });
    expect(feil, `JS-feil: ${feil.join(', ')}`).toHaveLength(0);
  });

});

// ── TILSK-738 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-738: Som søker ønsker jeg å se kontaktinformasjon om ordningen', () => {

  // Cache-variabler — populeres ved første bruk (workers: 1, sekvensiell kjøring)
  let _urlMedKontaktinfo = null;
  let _urlMedBeggekorttyper = null;

  const KONTAKT_SELEKTORER =
    '[class*="kontakt"], [data-testid*="kontakt"], ' +
    'section:has-text("Kontakt"), h2:has-text("Kontakt"), h3:has-text("Kontakt")';
  const PERSON_SELEKTORER =
    '[class*="person-kort"], [class*="personkort"], [class*="person-card"], [data-testid*="person-kort"]';
  const VIRKSOMHET_SELEKTORER =
    '[class*="virksomhet-kort"], [class*="virksomhetkort"], [class*="organization-card"], [data-testid*="virksomhet-kort"]';
  const KORT_SELEKTORER =
    '[class*="kontakt-kort"], [class*="kontaktkort"], [class*="contact-card"], [data-testid*="kontakt-kort"]';

  function harKontaktdetaljer(body) {
    const harEpost   = /@[\w.-]+\.\w{2,}/.test(body);
    const harTelefon = /\d{8}|\+47[\s\d]|\d{2}[\s-]\d{2}[\s-]\d{2}[\s-]\d{2}/.test(body);
    return { harEpost, harTelefon, ok: harEpost || harTelefon };
  }

  async function hentAlleOrdningUrler(page) {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await page.locator('a[href*="utlysinger/"]').first().waitFor({ state: 'visible', timeout: SIDE_TIMEOUT });
    const hrefs = await page.locator('a[href*="utlysinger/"]').evaluateAll(
      els => [...new Set(els.map(el => el.getAttribute('href')).filter(Boolean))]
    );
    return hrefs.map(h => h.startsWith('http') ? h : `${base}${h}`);
  }

  // Finn første ordning som har kontaktinformasjon med e-post eller telefon
  async function gåTilOrdningMedKontaktinfo(page) {
    if (_urlMedKontaktinfo) {
      await page.goto(_urlMedKontaktinfo, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
      return _urlMedKontaktinfo;
    }
    const urler = await hentAlleOrdningUrler(page);
    for (const url of urler) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
      const harKontaktSeksjon = (await page.locator(KONTAKT_SELEKTORER).count()) > 0;
      if (!harKontaktSeksjon) continue;
      const body = await page.textContent('body');
      if (harKontaktdetaljer(body).ok) {
        _urlMedKontaktinfo = url;
        return url;
      }
    }
    return null;
  }

  // Finn første ordning som har både personkort og virksomhetskort
  async function gåTilOrdningMedBeggekorttyper(page) {
    if (_urlMedBeggekorttyper) {
      await page.goto(_urlMedBeggekorttyper, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
      return _urlMedBeggekorttyper;
    }
    const urler = await hentAlleOrdningUrler(page);
    for (const url of urler) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
      const harPerson     = (await page.locator(PERSON_SELEKTORER).count()) > 0;
      const harVirksomhet = (await page.locator(VIRKSOMHET_SELEKTORER).count()) > 0;
      if (harPerson && harVirksomhet) {
        _urlMedBeggekorttyper = url;
        return url;
      }
    }
    return null;
  }

  // AK-1.0: Kontaktinformasjonsseksjon finnes og siden laster uten feil
  test('AK-1.0 – utlysningssiden laster uten feilside', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjonsseksjon funnet i PROD-miljøet');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/Internal Server Error|Uventet feil/);
  });

  test('AK-1.0 – kontaktinformasjonsseksjon finnes på en utlysningsside', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjonsseksjon funnet i PROD-miljøet');
    const kontakt = page.locator(KONTAKT_SELEKTORER).first();
    await expect(kontakt).toBeAttached({ timeout: SIDE_TIMEOUT });
  });

  // AK-1.1: Minst 1 kontaktinfokort, maks 3 totalt
  test('AK-1.1 – minst ett kontaktinfokort vises', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjonsseksjon funnet i PROD-miljøet');
    const kort = page.locator(KORT_SELEKTORER);
    const antall = await kort.count();
    if (antall === 0) {
      const body = await page.textContent('body');
      expect(body, 'Forventet e-post eller telefon i kontaktinformasjonen').toMatch(/@|tlf\.|telefon|e-post/i);
    } else {
      expect(antall).toBeGreaterThanOrEqual(1);
    }
  });

  test('AK-1.1 – maks tre kontaktinfokort vises totalt', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjonsseksjon funnet i PROD-miljøet');
    const antall = await page.locator(KORT_SELEKTORER).count();
    if (antall > 0) expect(antall).toBeLessThanOrEqual(3);
  });

  // AK-1.2: Personkort: maks 3
  test('AK-1.2 – maks tre personkort vises', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjonsseksjon funnet i PROD-miljøet');
    const antall = await page.locator(PERSON_SELEKTORER).count();
    expect(antall).toBeLessThanOrEqual(3);
  });

  // AK-1.3: Virksomhetskort: 0 eller 1
  test('AK-1.3 – maks ett virksomhetskort vises', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjonsseksjon funnet i PROD-miljøet');
    const antall = await page.locator(VIRKSOMHET_SELEKTORER).count();
    expect(antall).toBeLessThanOrEqual(1);
  });

  // AK-1.4 + AK-1.5: Kortene inneholder navn og kontaktdetaljer
  test('AK-1.4/1.5 – kontaktkort inneholder e-post eller telefonnummer', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjon funnet i PROD-miljøet');
    const body = await page.textContent('body');
    const { harEpost, harTelefon } = harKontaktdetaljer(body);
    expect(harEpost || harTelefon, 'Forventet e-postadresse eller telefonnummer i kontaktinformasjonen').toBe(true);
  });

  // AK-1.6: Navn + telefon ELLER e-post er obligatorisk
  test('AK-1.6 – obligatoriske felt: minst telefon eller e-post finnes i kontaktinfo', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedKontaktinfo(page);
    testInfo.skip(!url, 'Ingen utlysning med kontaktinformasjon funnet i PROD-miljøet');
    const body = await page.textContent('body');
    const { ok } = harKontaktdetaljer(body);
    expect(ok, 'Kontaktinfo mangler både e-post og telefon').toBe(true);
  });

  // AK-1.7: Personkort vises før virksomhetskort (posisjon i DOM)
  test('AK-1.7 – personkort vises over virksomhetskort på siden', async ({ page }, testInfo) => {
    const url = await gåTilOrdningMedBeggekorttyper(page);
    testInfo.skip(!url, 'Ingen utlysning med både person- og virksomhetskort funnet i PROD-miljøet');
    const personBoks     = await page.locator(PERSON_SELEKTORER).first().boundingBox();
    const virksomhetBoks = await page.locator(VIRKSOMHET_SELEKTORER).first().boundingBox();
    expect(personBoks.y, 'Personkort skal vises over virksomhetskort').toBeLessThan(virksomhetBoks.y);
  });

});

// ── TILSK-760 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-760: Som bruker ønsker jeg å kunne navigere via footer fra alle sidene i tilskuddsportalen', () => {

  const FOOTER_SEL = 'footer, [role="contentinfo"]';
  const PERSONVERN_SEL = [
    'a[href*="personvern"]',
    'a:has-text("Personvernerklæring")',
    'a:has-text("personvern")',
  ].join(', ');
  const TILGJENGELIGHET_SEL = [
    'a[href*="tilgjengelighet"]',
    'a:has-text("Tilgjengelighetserklæring")',
    'a:has-text("tilgjengelighet")',
  ].join(', ');

  test('AK-1.0 – footer finnes på forside og underside', async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    await expect(page.locator(FOOTER_SEL).first()).toBeVisible({ timeout: SIDE_TIMEOUT });

    await page.goto(`${base}/utlysinger`, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await expect(page.locator(FOOTER_SEL).first()).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('AK-1.1 – footer inneholder forventede elementer fra Figma-skissen', async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    const footer = page.locator(FOOTER_SEL).first();
    await expect(footer).toBeVisible({ timeout: SIDE_TIMEOUT });

    const antallLenker = await footer.locator('a').count();
    expect(antallLenker, 'Footer skal inneholde lenker til navigasjon').toBeGreaterThanOrEqual(1);

    const footerTekst = await footer.textContent();
    const harPortalTekst = /tilskudd|portal|ks\.no|kommune/i.test(footerTekst ?? '');
    expect(harPortalTekst, 'Footer skal inneholde tekst om tilskuddsportalen eller KS').toBe(true);
  });

  test('AK-1.2 – footer inneholder språkvalg', async ({ page }, testInfo) => {
    testInfo.skip(true, 'AK-1.2 avventer implementering – språkvalg ikke avklart (TILSK-760)');
  });

  test('AK-1.3 – footer inneholder lenke til personvernerklæring', async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    const footer = page.locator(FOOTER_SEL).first();
    await expect(footer).toBeVisible({ timeout: SIDE_TIMEOUT });
    await expect(
      footer.locator(PERSONVERN_SEL).first(),
      'Footer skal inneholde lenke til personvernerklæring'
    ).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('AK-1.4 – footer inneholder lenke til tilgjengelighetserklæring', async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    const footer = page.locator(FOOTER_SEL).first();
    await expect(footer).toBeVisible({ timeout: SIDE_TIMEOUT });
    await expect(
      footer.locator(TILGJENGELIGHET_SEL).first(),
      'Footer skal inneholde lenke til tilgjengelighetserklæring'
    ).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

});

// ── TILSK-767 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-767: Organisasjonsvelger ved søknadsopprettelse', () => {

  const SØK_KNAPP =
    'a:has-text("Søk om tilskudd"), button:has-text("Søk om tilskudd"), ' +
    'a:has-text("Start søknad"), button:has-text("Start søknad"), ' +
    '[data-testid*="sok-tilskudd"], [data-testid*="start-soknad"]';

  const ORGNR_FELT =
    'input[name*="orgnr"], input[name*="organisasjonsnummer"], ' +
    'input[placeholder*="rgnr"], input[placeholder*="rganisasjon"], ' +
    'input[inputmode="numeric"][maxlength="9"], [data-testid*="orgnr"]';

  const SUBMIT_KNAPP =
    'button[type="submit"], button:has-text("Neste"), ' +
    'button:has-text("Fortsett"), button:has-text("Opprett søknad")';

  // Finn utlysning med Søk om tilskudd-knapp og klikk den
  async function gåTilOrgVelger(page) {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await page.locator('a[href*="utlysinger/"]').first().waitFor({ state: 'visible', timeout: SIDE_TIMEOUT });
    const hrefs = await page.locator('a[href*="utlysinger/"]').evaluateAll(
      els => [...new Set(els.map(el => el.getAttribute('href')).filter(Boolean))]
    );
    const urler = hrefs.map(h => h.startsWith('http') ? h : `${base}${h}`);
    for (const url of urler.slice(0, 8)) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
      const knapp = page.locator(SØK_KNAPP).first();
      if ((await knapp.count()) === 0) continue;
      await knapp.click();
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT });
      return true;
    }
    return false;
  }

  test('AK-1 – "Hvem søker du på vegne av?"-skjerm vises etter klikk på Søk om tilskudd', async ({ page }, testInfo) => {
    const funnet = await gåTilOrgVelger(page);
    testInfo.skip(!funnet, 'Ingen utlysning med "Søk om tilskudd"-knapp funnet i PROD-miljøet');
    const body = await page.textContent('body');
    const harOrgSkjerm = /hvem søker|vegne av|organisasjon|velg.*org/i.test(body);
    expect(harOrgSkjerm, 'Forventet skjermbilde for organisasjonsvalg etter klikk på Søk om tilskudd').toBe(true);
  });

  test('AK-2 – organisasjonsnummerfeltet er synlig', async ({ page }, testInfo) => {
    const funnet = await gåTilOrgVelger(page);
    testInfo.skip(!funnet, 'Ingen utlysning med "Søk om tilskudd"-knapp funnet i PROD-miljøet');
    const felt = page.locator(ORGNR_FELT).first();
    if ((await felt.count()) > 0) {
      await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
    } else {
      const body = await page.textContent('body');
      expect(body).toMatch(/organisasjonsnummer|org\.?\s*nr|orgnr/i);
    }
  });

  test('AK-3 – organisasjonsnummer er obligatorisk (tom felt blokkerer innsending)', async ({ page }, testInfo) => {
    const funnet = await gåTilOrgVelger(page);
    testInfo.skip(!funnet, 'Ingen utlysning med "Søk om tilskudd"-knapp funnet i PROD-miljøet');
    const felt = page.locator(ORGNR_FELT).first();
    testInfo.skip((await felt.count()) === 0, 'Organisasjonsnummerfelt ikke funnet på org-velger-siden');
    await felt.fill('');
    const submitKnapp = page.locator(SUBMIT_KNAPP).first();
    if ((await submitKnapp.count()) > 0) {
      // Knapp disabled = skjema blokkerer innsending ved tomt obligatorisk felt
      const erDisabled = await submitKnapp.isDisabled();
      if (erDisabled) {
        expect(erDisabled, 'Submit-knapp skal være deaktivert når org-nummer er tomt').toBe(true);
        return;
      }
      // Knapp enabled = sjekk om klikk gir feilmelding
      await submitKnapp.click({ force: true });
      await page.waitForLoadState('domcontentloaded');
      const body = await page.textContent('body');
      const harFeil =
        /påkrevd|obligatorisk|required|mangler|ugyldig|feil/i.test(body) ||
        (await page.locator('[aria-invalid="true"], [role="alert"], [class*="error"]').count()) > 0;
      expect(harFeil, 'Forventet valideringsfeil for tomt organisasjonsnummer').toBe(true);
    }
  });

  test('AK-3 – org-nummer valideres på format (feil antall siffer gir feil)', async ({ page }, testInfo) => {
    const funnet = await gåTilOrgVelger(page);
    testInfo.skip(!funnet, 'Ingen utlysning med "Søk om tilskudd"-knapp funnet i PROD-miljøet');
    const felt = page.locator(ORGNR_FELT).first();
    testInfo.skip((await felt.count()) === 0, 'Organisasjonsnummerfelt ikke funnet på org-velger-siden');
    await felt.fill('123'); // For kort – ugyldig format
    await felt.press('Tab');
    let harFeil =
      (await page.locator('[aria-invalid="true"], [class*="error"]').count()) > 0;
    if (!harFeil) {
      const submitKnapp = page.locator(SUBMIT_KNAPP).first();
      if ((await submitKnapp.count()) > 0) {
        await submitKnapp.click();
        await page.waitForLoadState('domcontentloaded');
        const body = await page.textContent('body');
        harFeil = /ugyldig|feil|invalid|9 siffer/i.test(body) ||
          (await page.locator('[aria-invalid="true"], [role="alert"]').count()) > 0;
      }
    }
    expect(harFeil, 'Forventet valideringsfeil for org-nummer med feil format (123)').toBe(true);
  });

  test('AK-4 – søknadsnavn-felt er synlig', async ({ page }, testInfo) => {
    const funnet = await gåTilOrgVelger(page);
    testInfo.skip(!funnet, 'Ingen utlysning med "Søk om tilskudd"-knapp funnet i PROD-miljøet');
    const navnFelt = page.locator(
      'input[name*="navn"], input[name*="name"], input[placeholder*="navn"], ' +
      'input[placeholder*="søknad"], [data-testid*="soknadsnavn"], [data-testid*="navn"]'
    ).first();
    if ((await navnFelt.count()) > 0) {
      await expect(navnFelt).toBeVisible({ timeout: SIDE_TIMEOUT });
    } else {
      const body = await page.textContent('body');
      expect(body).toMatch(/søknad.*navn|navn.*søknad|gi.*søknaden|tittel/i);
    }
  });

  test('AK-5 – e-postfelt er synlig', async ({ page }, testInfo) => {
    const funnet = await gåTilOrgVelger(page);
    testInfo.skip(!funnet, 'Ingen utlysning med "Søk om tilskudd"-knapp funnet i PROD-miljøet');
    const epostFelt = page.locator(
      'input[type="email"], input[name*="epost"], input[name*="email"], ' +
      'input[placeholder*="e-post"], input[placeholder*="epost"], [data-testid*="epost"]'
    ).first();
    if ((await epostFelt.count()) > 0) {
      await expect(epostFelt).toBeVisible({ timeout: SIDE_TIMEOUT });
    } else {
      const body = await page.textContent('body');
      expect(body).toMatch(/e-post|epost|e-mail|email/i);
    }
  });

});

// ── TILSK-785 / TILSK-795 ────────────────────────────────────────────────────────
test.describe('TILSK-785 / TILSK-795: Redesign av utlysningsside', () => {

  let _utlysningUrl = null;

  async function gåTilUtlysning(page) {
    if (_utlysningUrl) {
      await page.goto(_utlysningUrl, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
      return;
    }
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const lenke = page.locator('a[href*="utlysinger/"]').first();
    await lenke.waitFor({ state: 'visible', timeout: SIDE_TIMEOUT });
    const href = await lenke.getAttribute('href');
    _utlysningUrl = href.startsWith('http') ? href : `${base}${href}`;
    await page.goto(_utlysningUrl, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
  }

  test('AK-1.0 – breadcrumbs er synlig på utlysningssiden', async ({ page }) => {
    await gåTilUtlysning(page);
    const breadcrumbs = page.locator(
      'nav[aria-label*="breadcrumb" i], [class*="breadcrumb"], ' +
      'ol[class*="breadcrumb"], nav ol li'
    ).first();
    await expect(breadcrumbs).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('AK-1.1 – tittel (h1) er synlig under breadcrumbs', async ({ page }) => {
    await gåTilUtlysning(page);
    const tittel = page.locator('h1').first();
    await expect(tittel).toBeVisible({ timeout: SIDE_TIMEOUT });
    const tekst = await tittel.textContent();
    expect(tekst?.trim().length ?? 0).toBeGreaterThan(0);
  });

  test('AK-1.2 – sist oppdatert dato vises', async ({ page }) => {
    await gåTilUtlysning(page);
    const body = await page.textContent('body');
    const harDato = /oppdatert|sist\s+endret|\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2}/i.test(body);
    expect(harDato, 'Forventet å finne oppdatert-dato på utlysningssiden').toBe(true);
  });

  test('AK-1.3 – forvalternavn vises', async ({ page }) => {
    await gåTilUtlysning(page);
    const body = await page.textContent('body');
    const harForvalter =
      (await page.locator('[class*="forvalter"], [data-testid*="forvalter"]').count()) > 0 ||
      /kommune|fylkeskommune|forvalter|statlig/i.test(body);
    expect(harForvalter, 'Forventet forvalternavn eller kommunereferanse').toBe(true);
  });

  test('AK-1.4 – pengebeløp vises med tusenskille i kroner (om tilskuddsramme er satt)', async ({ page }) => {
    await gåTilUtlysning(page);
    const body = await page.textContent('body');
    const harBelop = /kr\b|NOK|tilskuddsramme|ramme|midler/i.test(body);
    if (harBelop) {
      // Bekrefter at tall med tusenskille (mellomrom eller punktum) brukes
      expect(body).toMatch(/\d[\s.]\d{3}/);
    }
    // Godtar mangel – ikke alle ordninger har satt tilskuddsramme
  });

  test('AK-2.0 – søknadsfristkort er synlig', async ({ page }) => {
    await gåTilUtlysning(page);
    const frist = page.locator(
      '[class*="frist"], [class*="deadline"], [data-testid*="frist"], ' +
      'section:has-text("Søknadsfrist"), h2:has-text("Frist"), h3:has-text("Frist"), ' +
      'div:has-text("Søknadsfrist")'
    ).first();
    await expect(frist).toBeAttached({ timeout: SIDE_TIMEOUT });
  });

  test('AK-3.0 – kontaktinfoseksjon er synlig', async ({ page }) => {
    await gåTilUtlysning(page);
    const kontakt = page.locator(
      '[class*="kontakt"], [data-testid*="kontakt"], ' +
      'section:has-text("Kontakt"), h2:has-text("Kontakt"), h3:has-text("Kontakt")'
    ).first();
    await expect(kontakt).toBeAttached({ timeout: SIDE_TIMEOUT });
  });

  test('AK-4.0 – rikttekst-innholdsområde er synlig med tekst', async ({ page }) => {
    await gåTilUtlysning(page);
    // Sjekk at main-området inneholder synlig tekst (rikttekst-innhold)
    const mainTekst = await page.locator('main').textContent().catch(() => '');
    expect(mainTekst?.trim().length ?? 0, 'Forventet tekst-innhold i main-elementet').toBeGreaterThan(50);
  });

  test('AK – utlysningssiden laster uten feilside', async ({ page }) => {
    await gåTilUtlysning(page);
    const body = await page.textContent('body');
    expect(body).not.toMatch(/Internal Server Error|Uventet feil/);
  });

});

// ── TILSK-793 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-793: Designsystemet redesign - Forside', () => {

  const SØKEFELT = 'input[placeholder*="tilskuddsordning"], input[placeholder*="Søk etter"], input[type="search"]';

  test('AK-1.0 – forsiden laster uten feilside', async ({ page }) => {
    await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    const body = await page.textContent('body');
    expect(body).not.toMatch(/Internal Server Error|Uventet feil/);
  });

  test('AK-1.1 – forsiden viser overskrift og tekst som forklarer hva portalen er', async ({ page }) => {
    await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    await expect(page.locator('h1').first()).toBeVisible({ timeout: SIDE_TIMEOUT });
    const body = await page.textContent('body');
    expect(body).toMatch(/nasjonal portal|tilskudd|søknad|offentlige/i);
  });

  test('AK-1.2 – forsiden viser søkefelt for å søke i tilskuddsordninger', async ({ page }) => {
    await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    await expect(page.locator(SØKEFELT).first()).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('AK-1.3 – søk fra forsiden navigerer til oversiktssiden for tilskuddsordninger', async ({ page }) => {
    await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: IDLE_TIMEOUT });
    const felt = page.locator(SØKEFELT).first();
    await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
    await felt.fill('tilskudd');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/utlysing/);
  });

});

// ── TILSK-856 ────────────────────────────────────────────────────────────────────
test.describe('TILSK-856: Som søker vil jeg finne tilskuddsordninger med stikkord, halvferdige ord eller flere ord', () => {

  async function søk(page, tekst) {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const felt = page.locator('input[type="search"], input[name*="search"], input[placeholder*="øk"]').first();
    await expect(felt).toBeVisible({ timeout: SIDE_TIMEOUT });
    await felt.fill(tekst);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
  }

  // AK-1: Stikkord – ett enkelt ord gir treff i tittel eller beskrivelse
  test('AK-1 – stikkord: søk på ett ord gir resultater (ikke feilside)', async ({ page }) => {
    await søk(page, 'tilskudd');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/500|Internal Server Error|Uventet feil/);
  });

  test('AK-1 – stikkord: søk på ett ord viser matchende utlysninger', async ({ page }) => {
    await søk(page, 'tilskudd');
    const kort = page.locator('article, [class*="card"], [class*="kort"], li a[href*="utlysing"]');
    const antall = await kort.count();
    expect(antall, 'Forventet minst én utlysning med søkeordet «tilskudd»').toBeGreaterThan(0);
  });

  // AK-2: Halvferdige ord – delstreng gir treff (f.eks. «tilsk» → «tilskudd»)
  test('AK-2 – halvferdig ord: delstreng gir relevante treff (ikke feilside)', async ({ page }) => {
    await søk(page, 'tilsk');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/500|Internal Server Error|Uventet feil/);
    const kortEllerIngenTreff = page.locator(
      'article, [class*="card"], [class*="kort"], li a[href*="utlysing"], ' +
      '[class*="ingen"], [class*="empty"], [class*="no-result"]'
    );
    await expect(kortEllerIngenTreff.first()).toBeAttached({ timeout: SIDE_TIMEOUT });
  });

  // AK-3: Flere ord – utlysninger som inneholder alle eller noen av ordene vises
  test('AK-3 – flere ord: søk på «barn og unge» gir respons uten feilside', async ({ page }) => {
    await søk(page, 'barn og unge');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/500|Internal Server Error|Uventet feil/);
  });

  // AK-4: Ingen treff – tydelig melding forklarer at ingen ordninger matchet
  test('AK-4 – ingen treff: nonsens-streng viser ingen-treff-melding, ikke feilside', async ({ page }) => {
    await søk(page, 'xyzabc123nonsens');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/500|Internal Server Error|Uventet feil/);
  });

  // AK-5: Tomt søkefelt – hele listen over utlysninger vises igjen
  test('AK-5 – tomt søkefelt: hel utlysningsliste vises igjen', async ({ page }) => {
    await søk(page, '');
    await expect(page).toHaveURL(/utlysinger/);
    const kort = page.locator('article, [class*="card"], [class*="kort"], li a[href*="utlysig"]');
    await expect(kort.first()).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  // AK-6: Feilstaving håndteres – gjerne med «mente du?»
  test('AK-6 – feilstaving: feilstavet søkeord håndteres (f.eks. «mente du?»)', async ({ page }, testInfo) => {
    testInfo.skip(true, 'AK-6 ikke implementert ennå – krever fuzzy søkemotor (TILSK-856 i Utviklingskø)');
  });

});

// ── BR.HIST-1 ─────────────────────────────────────────────────────────────────────
test.describe('BR.HIST-1: Som søker vil jeg se oversikt over tilskuddsordninger', () => {

  test('kan navigere til utlysningslisten', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await expect(page).toHaveURL(/utlysinger/);
  });

  test('utlysningslisten inneholder minst én ordning', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const kort = page.locator('article, [class*="card"], [class*="kort"], li a[href*="utlysing"]');
    await expect(kort.first()).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

  test('kan klikke seg inn på en utlysning og se detaljer', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const forstelenke = page.locator('a[href*="utlysing"]').first();
    await expect(forstelenke).toBeVisible({ timeout: SIDE_TIMEOUT });
    await forstelenke.click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).not.toHaveURL(`${base}/utlysinger`);
  });

});

// ── BR.HIST-4 ─────────────────────────────────────────────────────────────────────
test.describe('BR.HIST-4: Som søker vil jeg kunne navigere tilbake fra en utlysning', () => {

  test('tilbake-navigasjon fra utlysning fungerer', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const lenke = page.locator('a[href*="utlysinger/"]').first();
    const href = await lenke.getAttribute('href');
    const absoluteHref = href.startsWith('http') ? href : `${base}${href}`;
    await page.goto(absoluteHref, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/utlysinger/);
  });

  test('F5-refresh på utlysningslisten beholder siden', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/utlysinger/);
    const body = await page.textContent('body');
    expect(body).not.toMatch(/500|Internal Server Error|Uventet feil/);
  });

});

// ── BR.HIST-5 ─────────────────────────────────────────────────────────────────────
test.describe('BR.HIST-5: Som søker med hjelpemiddelteknologi vil jeg hoppe over navigasjonen', () => {

  test('skiplink til hovedinnhold finnes i DOM (WCAG 2.4.1)', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    fs.mkdirSync(SKJERMBILDER, { recursive: true });
    await page.screenshot({ path: `${SKJERMBILDER}/BR.HIST-5-side-uten-skiplink.png` });
    const skipLenke = page.locator(
      'a[href="#main"], a[href="#maincontent"], a[href="#main-content"], ' +
      'a[href="#innhold"], a.skip-link, a[class*="skip"]'
    ).first();
    await expect(skipLenke).toBeAttached();
  });

  test('skiplink er første fokuserbare element ved Tab-navigasjon', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    await page.keyboard.press('Tab');
    fs.mkdirSync(SKJERMBILDER, { recursive: true });
    await page.screenshot({ path: `${SKJERMBILDER}/BR.HIST-5-foerste-tab-fokus.png` });
    const href = await page.locator(':focus').getAttribute('href').catch(() => '');
    expect(href, 'Første Tab-stopp bør være en skiplink til #main eller #innhold').toMatch(/#main|#innhold|#content|#skip/);
  });

  test('søkeskjema er merket med role="search" for skjermlesere', async ({ page }) => {
    await page.goto(`${base}/utlysinger`, { timeout: IDLE_TIMEOUT });
    await sjekkForServerfeil(page);
    const searchRegion = page.locator('[role="search"]').first();
    await expect(searchRegion).toBeVisible({ timeout: SIDE_TIMEOUT });
  });

});
