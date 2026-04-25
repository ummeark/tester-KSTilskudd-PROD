// Felles konfigurasjon for alle testskript.
// Verdier kan overstyres via kommandolinjeargumenter eller miljøvariabler.

export const START_URL = process.argv[2] || process.env.TEST_URL || 'https://tilskudd.fiks.ks.no/';

export const MAX_SIDER    = parseInt(process.argv[3]) || parseInt(process.env.MAX_SIDER)    || 20;
export const ITERASJONER  = parseInt(process.argv[3]) || parseInt(process.env.ITERASJONER)  || 60;

export const VIEWPORT = { width: 1280, height: 900 };

// Timeouts (ms)
export const SIDE_TIMEOUT  = 15000;   // domcontentloaded-navigasjoner
export const IDLE_TIMEOUT  = 20000;   // networkidle-navigasjoner
export const LAST_TIMEOUT  = 30000;   // fulle sideinnlastinger (ytelse/UU-crawl)
export const HTTP_TIMEOUT  = 8000;    // HTTP HEAD/GET-forespørsler (sikkerhet)
export const LINK_TIMEOUT  = 6000;    // lenkesjekk med fetch

// Ord som indikerer en feilside (brukt i monkey-test)
export const KRASJ_ORD = [
  '500', 'Internal Server Error', 'Something went wrong',
  'Uventet feil', 'Oops', 'Ops!', '404 – Siden',
];
