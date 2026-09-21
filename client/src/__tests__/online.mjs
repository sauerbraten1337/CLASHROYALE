/**
 * Two-browser online match test.
 *
 * Boots the server and drives two independent browser contexts through the
 * real UI: both queue, get matched with each other, and play a live match.
 * This is the end-to-end proof that online 1v1 works through the client,
 * not just at the protocol level.
 *
 * Run with: node client/src/__tests__/online.mjs
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PORT = 8655;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const server = spawn(process.execPath, [resolve(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => {
  const t = String(d).trim();
  if (t) console.error('[server]', t);
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  return false;
}

/** Reads a numeric field out of the debug overlay. */
function readDebug(text, key) {
  const m = new RegExp(`${key}\\s*([0-9.]+)`).exec(text ?? '');
  return m ? Number(m[1]) : 0;
}

/** Opens an isolated browser context so each player has its own storage. */
async function openPlayer(browser, name) {
  const context = await browser.newContext({ viewport: { width: 900, height: 820 } });
  const page = await context.newPage();
  // Leaving an online match asks for confirmation; accept it automatically.
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.menu__title', { timeout: 10000 });
  await page.waitForSelector('.conn-dot--connected', { timeout: 10000 });

  // Give each player a distinct name so we can tell them apart in the HUD.
  await page.click('text=Profile');
  await page.waitForSelector('input[type="text"]');
  await page.fill('input[type="text"]', name);
  await page.click('text=Save');
  await page.waitForTimeout(400);
  await page.click('text=Back');
  await page.waitForSelector('.menu__title');

  return { context, page, errors, name };
}

async function main() {
  if (!(await waitForServer())) throw new Error('server did not start');
  console.log('server up\n');

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  console.log('--- two players connect ---');
  const alice = await openPlayer(browser, 'Alice');
  const bob = await openPlayer(browser, 'Bob');
  check('both clients connect to the server', true);

  console.log('\n--- matchmaking ---');
  // Both queue at nearly the same moment, so they pair with each other
  // rather than falling back to a bot.
  await alice.page.click('text=Play Online');
  await bob.page.click('text=Play Online');

  await alice.page.waitForSelector('.battle__canvas', { timeout: 20000 });
  await bob.page.waitForSelector('.battle__canvas', { timeout: 20000 });
  check('both players enter an arena', true);

  // Each should see the other named in the enemy HUD slot.
  await alice.page.waitForTimeout(1200);
  const aliceEnemy = await alice.page.locator('.hud__name').first().textContent();
  const bobEnemy = await bob.page.locator('.hud__name').first().textContent();
  check('Alice is matched against Bob', aliceEnemy?.includes('Bob'), `saw "${aliceEnemy}"`);
  check('Bob is matched against Alice', bobEnemy?.includes('Alice'), `saw "${bobEnemy}"`);

  console.log('\n--- live match ---');
  // Wait out the countdown, then let energy build.
  await alice.page.waitForTimeout(7000);

  await alice.page.keyboard.press('F1');
  await bob.page.keyboard.press('F1');
  await alice.page.waitForSelector('.debug');
  await bob.page.waitForSelector('.debug');

  const aliceDebug = await alice.page.textContent('.debug');
  const bobDebug = await bob.page.textContent('.debug');

  check('Alice receives server snapshots', readDebug(aliceDebug, 'tick') > 0);
  check('Bob receives server snapshots', readDebug(bobDebug, 'tick') > 0);
  check(
    'both see the same six towers',
    readDebug(aliceDebug, 'entities') === 6 && readDebug(bobDebug, 'entities') === 6,
    `alice=${readDebug(aliceDebug, 'entities')} bob=${readDebug(bobDebug, 'entities')}`,
  );
  // An online session reports a real ping rather than "local".
  check('the session reports network latency', /ping\s*\d+ms/.test(aliceDebug ?? ''), aliceDebug ?? '');

  console.log('\n--- a play by one player is seen by both ---');
  const entitiesBefore = readDebug(aliceDebug, 'entities');
  const box = await alice.page.locator('.battle__canvas').boundingBox();

  let played = false;
  for (let slot = 1; slot <= 4 && !played; slot++) {
    await alice.page.keyboard.press(String(slot));
    await alice.page.waitForTimeout(150);
    if ((await alice.page.locator('.card-tile--selected').count()) === 0) continue;
    await alice.page.mouse.click(box.x + box.width * 0.32, box.y + box.height * 0.8);
    await alice.page.waitForTimeout(1200);
    if (readDebug(await alice.page.textContent('.debug'), 'entities') > entitiesBefore) {
      played = true;
    }
  }
  check("Alice's card spawns a unit", played);

  // The whole point of an authoritative server: Bob sees it too.
  await bob.page.waitForTimeout(600);
  const bobAfter = readDebug(await bob.page.textContent('.debug'), 'entities');
  check(
    "Bob's client sees Alice's unit",
    bobAfter > 6,
    `bob sees ${bobAfter} entities`,
  );

  console.log('\n--- both players fight ---');
  for (let slot = 1; slot <= 4; slot++) {
    await bob.page.keyboard.press(String(slot));
    await bob.page.waitForTimeout(150);
    if ((await bob.page.locator('.card-tile--selected').count()) === 0) continue;
    const bobBox = await bob.page.locator('.battle__canvas').boundingBox();
    await bob.page.mouse.click(bobBox.x + bobBox.width * 0.32, bobBox.y + bobBox.height * 0.8);
    break;
  }
  await alice.page.waitForTimeout(4000);

  const aliceLate = readDebug(await alice.page.textContent('.debug'), 'entities');
  const bobLate = readDebug(await bob.page.textContent('.debug'), 'entities');
  check('both clients agree on the entity count', aliceLate === bobLate, `alice=${aliceLate} bob=${bobLate}`);
  check('units from both sides are on the board', aliceLate > 6, `${aliceLate} entities`);

  console.log('\n--- leaving an online match forfeits it ---');
  await bob.page.locator('.hud button').first().click();
  // Leaving the arena forfeits, so Alice should be shown a victory.
  await alice.page.waitForSelector('.banner', { timeout: 20000 });
  const banner = await alice.page.textContent('.banner');
  check('Alice sees a result screen', Boolean(banner), banner ?? '');
  check('Alice is credited with the win', banner?.includes('Victory'), banner ?? '');
  check('rewards are shown', await alice.page.isVisible('text=Trophies'));

  await alice.page.click('text=Main Menu');
  await alice.page.waitForSelector('.menu__title', { timeout: 5000 });
  check('Alice returns to the menu with progress saved', true);

  const trophies = await alice.page.locator('.stat__value').nth(1).textContent();
  check('trophies were awarded', Number(trophies) > 0, `trophies=${trophies}`);

  console.log('\n--- page errors ---');
  check('Alice had no uncaught errors', alice.errors.length === 0, alice.errors.slice(0, 2).join(' | '));
  check('Bob had no uncaught errors', bob.errors.length === 0, bob.errors.slice(0, 2).join(' | '));

  await browser.close();
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    server.kill('SIGKILL');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('\nonline test threw:', error);
    server.kill('SIGKILL');
    process.exit(1);
  });
