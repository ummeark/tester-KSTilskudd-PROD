import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { START_URL } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(__dirname, 'prod-auth.json');

console.log(`\n🌐 Åpner nettleser og navigerer til: ${START_URL}`);
console.log('📋 Logg inn med din ID-porten-konto i nettleservinduet.');
console.log('   Scriptet fortsetter automatisk når du er innlogget.\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

await page.waitForURL(url => !url.includes('idporten.no'), { timeout: 120000 })
  .catch(() => {
    console.log('⏰ Timeout – du tok for lang tid. Prøv igjen.');
    process.exit(1);
  });

console.log(`✅ Innlogget! Landet på: ${page.url()}`);
await context.storageState({ path: authFile });
console.log(`💾 Sesjonen er lagret til prod-auth.json`);
console.log('   Kjør testene nå med f.eks. npm run rapport\n');

await browser.close();
