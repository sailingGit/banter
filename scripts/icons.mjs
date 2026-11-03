// Renders the extension icons from assets/*.svg with Playwright's Chromium.
// The small sizes use a simplified drawing that stays legible in the toolbar.
// Usage: npm run icons
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const SOURCES = { 16: 'assets/logo-small.svg', 32: 'assets/logo-small.svg', 48: 'assets/logo.svg', 128: 'assets/logo.svg' };

await mkdir('src/icons', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  for (const [size, source] of Object.entries(SOURCES)) {
    const svg = (await readFile(source)).toString('base64');
    const page = await browser.newPage({ viewport: { width: +size, height: +size } });
    await page.setContent(
      `<body style="margin:0"><img src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}" style="display:block"></body>`,
    );
    await page.screenshot({ path: `src/icons/icon-${size}.png`, omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('icons written to src/icons');
