/**
 * Browser smoke test.
 *
 * Boots the real server with the built client, drives it in Chromium, and
 * plays an actual match: navigate the menus, start a bot match, place a
 * card, and confirm something spawned and the arena is rendering.
 *
 * Compiling is not evidence that a game works. This is.
 *
 * Run with: node client/src/__tests__/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PORT = 8611;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const server = spawn(process.execPath, [resolve(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => {
  const text = String(d).trim();
  if (text) console.error('[server]', text);
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

async function main() {
  if (!(await waitForServer())) throw new Error('server did not start');
  console.log('server up');

  // Use the Chromium already present in this environment rather than the
  // build this Playwright version would otherwise download.
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

  // Any uncaught page error is a failure: the game must not throw in normal use.
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
  });

  console.log('\n--- main menu ---');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.menu__title', { timeout: 10000 });

  const title = await page.textContent('.menu__title');
  check('renders the game title', title?.includes('Riftbound'), title);
  check('shows the play button', await page.isVisible('text=Play Online'));
  check('shows the bot button', await page.isVisible('text=Play vs Bot'));

  // The connection indicator should reach "connected" against a live server.
  await page.waitForSelector('.conn-dot--connected', { timeout: 8000 });
  check('connects to the server', true);

  console.log('\n--- collection ---');
  await page.click('text=Collection');
  await page.waitForSelector('.collection', { timeout: 5000 });
  const tiles = await page.locator('.collection .card-tile').count();
  check('collection lists cards', tiles >= 12, `${tiles} tiles`);
  // Card art is drawn procedurally: every tile should hold a canvas.
  const canvases = await page.locator('.collection canvas').count();
  check('every card renders its art', canvases === tiles, `${canvases}/${tiles} canvases`);
  check('shows a card detail panel', await page.isVisible('.card-detail'));
  await page.click('text=Back');

  console.log('\n--- deck builder ---');
  await page.waitForSelector('.menu__title');
  await page.click('text=Deck');
  await page.waitForSelector('.deck-slots', { timeout: 5000 });
  const slots = await page.locator('.deck-slots .card-tile').count();
  check('deck builder shows a full deck', slots === 8, `${slots} cards`);
  check('shows deck statistics', await page.isVisible('text=Average energy'));
  check('shows the cost curve', await page.isVisible('text=Cost curve'));

  // Removing a card should open an empty slot.
  await page.locator('.deck-slots .card-tile').first().click();
  await page.waitForTimeout(150);
  const emptied = await page.locator('.deck-slot--empty').count();
  check('removing a card frees a slot', emptied === 1, `${emptied} empty`);
  // Auto-fill should close it again.
  await page.click('text=Auto-fill');
  await page.waitForTimeout(200);
  const refilled = await page.locator('.deck-slot--empty').count();
  check('auto-fill completes the deck', refilled === 0, `${refilled} empty`);
  await page.click('text=Back');

  console.log('\n--- bot match ---');
  await page.waitForSelector('.menu__title');
  await page.click('text=Play vs Bot');
  await page.waitForSelector('.difficulty-grid', { timeout: 5000 });
  check('offers three difficulties', (await page.locator('.difficulty').count()) === 3);
  await page.click('text=Start Match');

  await page.waitForSelector('.battle__canvas', { timeout: 8000 });
  check('enters the arena', true);
  check('shows the energy bar', await page.isVisible('.energy__track'));

  // The hand fills from the first snapshot, which lands on the first frame
  // rather than synchronously with the canvas mounting.
  await page.waitForSelector('.hand__cards .card-tile', { timeout: 5000 });
  const handSize = await page.locator('.hand__cards .card-tile').count();
  check('deals a hand of four', handSize === 4, `${handSize} cards`);
  check('shows the next card up', await page.isVisible('.hand__next'));

  // Wait out the 3s countdown and bank enough energy to afford something.
  await page.waitForTimeout(6000);

  const energyText = await page.textContent('.energy__value');
  const energy = parseFloat(energyText ?? '0');
  check('energy regenerates', energy > 0, `${energyText}`);

  // Turn on the debug overlay to read the live entity count.
  await page.keyboard.press('F1');
  await page.waitForSelector('.debug', { timeout: 3000 });
  const debugBefore = await page.textContent('.debug');
  const entitiesBefore = readDebug(debugBefore, 'entities');
  check('towers are on the board', entitiesBefore >= 6, `${entitiesBefore} entities`);

  const fps = readDebug(debugBefore, 'fps');
  check('renders at a playable frame rate', fps >= 20, `${fps} fps`);

  // Play a card: select the cheapest affordable slot, then tap our own half.
  console.log('\n--- playing a card ---');
  const box = await page.locator('.battle__canvas').boundingBox();
  let played = false;
  for (let slot = 1; slot <= 4 && !played; slot++) {
    await page.keyboard.press(String(slot));
    await page.waitForTimeout(150);
    const selected = await page.locator('.card-tile--selected').count();
    if (selected === 0) continue; // not affordable

    // Click in the lower third, which is the player's own half.
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.78);
    await page.waitForTimeout(900);

    const after = await page.textContent('.debug');
    if (readDebug(after, 'entities') > entitiesBefore) played = true;
  }
  check('playing a card spawns something on the board', played);

  // Let the match run so units fight and the bot responds.
  await page.waitForTimeout(6000);
  const midMatch = await page.textContent('.debug');
  check('match is still running', readDebug(midMatch, 'tick') > 0);
  check(
    'both sides have units fighting',
    readDebug(midMatch, 'entities') > 6,
    `${readDebug(midMatch, 'entities')} entities`,
  );

  console.log('\n--- responsive layout ---');
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['tablet', { width: 834, height: 1112 }],
    ['phone', { width: 390, height: 844 }],
    ['phone landscape', { width: 844, height: 390 }],
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    // Nothing may overflow horizontally, and the arena must stay visible.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    const canvasVisible = await page.isVisible('.battle__canvas');
    const handVisible = await page.isVisible('.hand__cards');
    check(`${label}: no horizontal overflow`, !overflow);
    check(`${label}: arena and hand both visible`, canvasVisible && handVisible);
  }

  await page.setViewportSize({ width: 1280, height: 860 });

  console.log('\n--- leaving the match ---');
  await page.locator('.hud button').first().click();
  await page.waitForSelector('.menu__title', { timeout: 5000 });
  check('returns to the main menu', true);

  console.log('\n--- page errors ---');
  check('no uncaught errors during play', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  
  await browser.close();
}

/** Pulls a numeric field out of the debug overlay text. */
function readDebug(text, key) {
  const match = new RegExp(`${key}\\s*([0-9.]+)`).exec(text ?? '');
  return match ? Number(match[1]) : 0;
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    server.kill('SIGKILL');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('\nsmoke test threw:', error);
    server.kill('SIGKILL');
    process.exit(1);
  });
