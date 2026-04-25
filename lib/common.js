import { SIDE_TIMEOUT } from '../config.js';

/**
 * Henter versjonsnummer fra siden (f.eks. v0.4.3).
 * @param {import('playwright').BrowserContext} ctx
 * @param {string} startUrl
 */
export async function hentVersjon(ctx, startUrl) {
  const p = await ctx.newPage();
  try {
    await p.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: SIDE_TIMEOUT });
    const tekst = await p.evaluate(() => document.body.innerText);
    const match = tekst.match(/v\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  } catch { return null; } finally { await p.close(); }
}

/**
 * Navigerer til URL og returnerer true/false.
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {number} [timeout]
 */
export async function gåTil(page, url, timeout = SIDE_TIMEOUT) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    return true;
  } catch { return false; }
}

/**
 * Sjekker om tekst inneholder krasjindikatorer.
 * @param {string} tekst
 */
export function sjekkKrasj(tekst) {
  return ['500', 'internal server error', 'something went wrong', 'uventet feil', 'oops']
    .some(ord => tekst.toLowerCase().includes(ord));
}

/**
 * Sjekker om tekst inneholder feilmeldingsindikatorer.
 * @param {string} tekst
 * @param {string[]} [feilord]
 */
export function sjekkFeilmelding(tekst, feilord = ['feil', 'error', 'ugyldig', 'mangler', 'påkrevd', 'required', 'invalid', 'ikke gyldig', 'ikke tillatt']) {
  const lower = tekst.toLowerCase();
  return feilord.some(ord => lower.includes(ord));
}
