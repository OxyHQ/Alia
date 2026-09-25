/**
 * A visual QA sweep of the web app: every screen, menu and panel that renders
 * without an account, at every §12 width, light and dark — screenshotted for a
 * person to LOOK at, and checked mechanically for what a person misses.
 *
 * Not a regression gate. `capture.mjs --check` is the gate, on a pinned clock
 * and a blocked network; this sweep lets the app run in real time so menus,
 * toasts and panels can be opened, and writes its pictures outside the repo.
 *
 *     node scripts/visual/qa-sweep.mjs --out <dir> [--only <text>] [--engine firefox]
 *
 * It drives two exports, both built on demand like the other harnesses:
 *
 *   - `dist/`, the production export, signed out: the welcome, "Continue
 *     without an account", the empty chat, the drawer, settings, and the
 *     composer's menus.
 *   - `dist-fixtures/` (`EXPO_PUBLIC_ALIA_FIXTURES=1`, see
 *     `scripts/perf/workspace.mjs`): `/__fixtures/:id` renders the real chat
 *     workspace in the real `(app)` layout over a generated conversation —
 *     long replies, code blocks, tables, attachments — so the thread, its turn
 *     actions, the header menu and the right panel can be looked at without
 *     an account or an API.
 *
 * For every capture it records, in `<out>/report.json`:
 *
 *   - `overflowX`: the document scrolls sideways (it never should);
 *   - `offscreen`: visible text or controls whose box ends past the right
 *     edge or starts left of 0, excluding what a clipping ancestor hides;
 *   - `overlapComposer`: text drawn under the composer's box (a message, a
 *     suggestion) — the composer must never cover what it is not meant to;
 *   - `composerVisible`: the composer's input is fully inside the viewport,
 *     for the screens that have one;
 *   - `focus`: for the keyboard pass, the element focused after each Tab and
 *     whether it draws a visible ring (outline or box-shadow).
 *
 * The network is allowed except for analytics, so signed-out reads (the model
 * catalogue) answer as they do in production.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium, firefox } from 'playwright-core';
import { serveExport } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '../..');

const WIDTHS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
/** A short phone, and the same phone with a virtual keyboard up (see `keyboard`). */
const SHORT = { width: 390, height: 640 };

function parseArgs(argv) {
  const args = { out: null, only: null, engine: 'chromium', themes: ['light', 'dark'], widths: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = resolve(argv[(i += 1)]);
    else if (arg === '--only') args.only = argv[(i += 1)];
    else if (arg === '--engine') args.engine = argv[(i += 1)];
    else if (arg === '--theme') args.themes = [argv[(i += 1)]];
    else if (arg === '--widths') args.widths = argv[(i += 1)].split(',').map(Number);
  }
  if (!args.out) throw new Error('--out <dir> is required (screenshots are never written into the repo)');
  return args;
}

function run(command, commandArgs, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { cwd: APP_ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} exited with ${code}`))));
  });
}

async function ensureExport(dir, env) {
  if (existsSync(join(APP_ROOT, dir, 'index.html'))) return join(APP_ROOT, dir);
  console.log(`· exporting ${dir}`);
  await run('bun', ['x', 'expo', 'export', '--platform', 'web', '--output-dir', dir], env);
  return join(APP_ROOT, dir);
}

// ── In-page checks ──────────────────────────────────────────────────────────

/** Runs in the page. Everything the report says about one capture. */
function inspect() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  /** The box that actually shows: the element's rect cut by every clipping ancestor. */
  const shown = (el) => {
    let rect = el.getBoundingClientRect();
    let box = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY)) {
        const r = p.getBoundingClientRect();
        box = {
          left: Math.max(box.left, r.left),
          right: Math.min(box.right, r.right),
          top: Math.max(box.top, r.top),
          bottom: Math.min(box.bottom, r.bottom),
        };
      }
    }
    return box;
  };
  const describe = (el) => {
    const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || '';
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${label}"`;
  };

  const leaves = [...document.querySelectorAll('body *')].filter(
    (el) => visible(el) && (el.matches('button, a, input, textarea, [role=button], [role=menuitem]') ||
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)),
  );
  const offscreen = [];
  for (const el of leaves) {
    const rect = el.getBoundingClientRect();
    const box = shown(el);
    if (box.right <= box.left || box.bottom <= box.top) continue; // clipped away entirely
    if (rect.right > vw + 1 && box.right > vw + 1) offscreen.push(`${describe(el)} → right ${Math.round(rect.right)} > ${vw}`);
    else if (rect.left < -1 && box.left < -1) offscreen.push(`${describe(el)} → left ${Math.round(rect.left)}`);
  }

  // The composer: Bloom's composer holds the one textarea on a chat screen.
  const input = [...document.querySelectorAll('textarea')].find(visible) ?? null;
  let composerVisible = null;
  const overlapComposer = [];
  if (input) {
    const r = input.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : vh;
    composerVisible = r.top >= top - 1 && r.bottom <= bottom + 1;
    // The composer's surface: the nearest ancestor that paints a background
    // and is wider than the input — the rounded card around it.
    let card = input;
    for (let p = input.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && p.getBoundingClientRect().width >= r.width) {
        card = p;
        break;
      }
    }
    const c = card.getBoundingClientRect();
    // Content scrolled behind the composer is how a thread scrolls; covered
    // text is a defect only at rest at the bottom, where the last turn must
    // clear the composer.
    const atBottom = window.scrollY + vh >= doc.scrollHeight - 2;
    for (const el of atBottom ? leaves : []) {
      if (card.contains(el) || el.contains(card)) continue;
      // A closed drawer is inert and hidden from assistive tech by design.
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      if (!el.textContent?.trim()) continue;
      const e = el.getBoundingClientRect();
      const box = shown(el);
      if (box.bottom <= box.top) continue;
      const overlaps = e.left < c.right && e.right > c.left && box.top < c.bottom - 2 && box.bottom > c.top + 2;
      if (!overlaps) continue;
      // Text genuinely under the card is only a defect if the card is not
      // painted over it on purpose (a scroll edge fade is not "covering").
      const topEl = document.elementFromPoint(
        Math.min(Math.max((e.left + e.right) / 2, 1), vw - 1),
        Math.min(Math.max((box.top + box.bottom) / 2, 1), vh - 1),
      );
      if (topEl && !el.contains(topEl) && card.contains(topEl)) {
        overlapComposer.push(describe(el));
      }
    }
  }

  return {
    scrollWidth: doc.scrollWidth,
    clientWidth: vw,
    overflowX: doc.scrollWidth > vw,
    offscreen: offscreen.slice(0, 8),
    composerVisible,
    overlapComposer: overlapComposer.slice(0, 5),
  };
}

/** Runs in the page: the focused element and whether it shows a ring. */
function focusInfo() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  const ring =
    (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
    (s.boxShadow && s.boxShadow !== 'none');
  const r = el.getBoundingClientRect();
  return {
    el: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`,
    ring: Boolean(ring),
    inView: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
  };
}

// ── Driving ─────────────────────────────────────────────────────────────────

const byLabel = (page, label) => page.locator(`[aria-label="${label}"]`).filter({ visible: true }).first();
const byText = (page, text) => page.getByText(text, { exact: true }).filter({ visible: true }).first();

async function settle(page, ms = 600) {
  await page.waitForTimeout(ms);
}

async function tryClick(locator, timeout = 4000) {
  try {
    await locator.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

/** The signed-out welcome, dismissed into the chat. */
async function enterChat(page) {
  await byText(page, 'Continue without an account').waitFor({ timeout: 60_000 });
  await settle(page, 1500);
  await tryClick(byText(page, 'Continue without an account'));
  await page.locator('textarea').filter({ visible: true }).first().waitFor({ timeout: 30_000 });
  await settle(page, 1200);
}

async function openDrawerIfMobile(page) {
  const open = byLabel(page, 'Open navigation');
  if (await open.count()) {
    await tryClick(open);
    await settle(page, 800);
    return true;
  }
  return false;
}

/** Escape does not close Bloom's nav drawer (see the report); its veil does. */
async function closeDrawer(page) {
  const close = page.locator('[aria-label="Close navigation"]').filter({ visible: true });
  if (await close.count()) await tryClick(close.last());
  await settle(page, 800);
}

/**
 * Each scenario gets a fresh page at `url` and takes named shots through
 * `shot(name)`. `wide` scenarios run at every width; others only where named.
 */
const SCENARIOS = [
  {
    name: 'welcome',
    dist: 'prod',
    url: '/',
    async run(page, shot) {
      await byText(page, 'Continue without an account').waitFor({ timeout: 60_000 });
      await settle(page, 2500);
      await shot('welcome');
    },
  },
  {
    name: 'chat-empty',
    dist: 'prod',
    url: '/',
    async run(page, shot, ctx) {
      await enterChat(page);
      await shot('chat-empty');
      if (await openDrawerIfMobile(page)) {
        await shot('drawer-open');
        await page.keyboard.press('Escape');
        await settle(page, 800);
        await shot('drawer-after-escape');
        await closeDrawer(page);
      }
      // The composer's menus.
      if (await tryClick(byLabel(page, 'Add attachment'))) {
        await settle(page);
        await shot('add-menu');
        await page.keyboard.press('Escape');
        await settle(page);
      }
      if (await tryClick(byLabel(page, 'Permission: Chat'))) {
        await settle(page, 800);
        await shot('mode-picker');
        await page.keyboard.press('Escape');
        await settle(page);
      }
      // The model picker is offered only where the catalogue answers.
      const picker = page.locator('button').filter({ hasText: /^Auto$/ }).filter({ visible: true });
      if ((await picker.count()) && (await tryClick(picker.last()))) {
        await settle(page, 1200);
        await shot('model-picker');
        await page.keyboard.press('Escape');
        await settle(page);
      }
      // Typing a long message: the composer grows, stays on screen.
      const input = page.locator('textarea').filter({ visible: true }).first();
      await input.click();
      await input.fill('A long message that wraps. '.repeat(ctx.width < 500 ? 12 : 20));
      await settle(page);
      await shot('composer-long-text');
      await input.fill('');
      // The virtual keyboard, as `interactive-widget=resizes-content` lays it
      // out: the layout viewport loses the keyboard's height.
      if (ctx.width < 768) {
        await input.focus();
        await page.setViewportSize({ width: ctx.width, height: Math.round(ctx.height * 0.55) });
        await settle(page, 800);
        await shot('keyboard-up');
        await page.setViewportSize({ width: ctx.width, height: ctx.height });
        await settle(page, 500);
      }
    },
  },
  {
    name: 'palette',
    dist: 'prod',
    url: '/',
    async run(page, shot) {
      await enterChat(page);
      await page.keyboard.press('Control+k');
      await settle(page, 800);
      await shot('command-palette');
      await page.keyboard.press('Escape');
      await settle(page);
      await page.keyboard.press('Control+/');
      await settle(page, 800);
      await shot('shortcuts-dialog');
      await page.keyboard.press('Escape');
      await settle(page);
      await shot('after-escape');
    },
  },
  {
    name: 'settings',
    dist: 'prod',
    url: '/settings',
    async run(page, shot) {
      await settle(page, 4000);
      await shot('settings');
    },
  },
  {
    name: 'focus',
    dist: 'prod',
    url: '/',
    widths: [390, 1280],
    async run(page, shot, ctx) {
      await enterChat(page);
      await page.locator('textarea').filter({ visible: true }).first().focus();
      const trail = [];
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press('Tab');
        await settle(page, 150);
        trail.push(await page.evaluate(focusInfo));
      }
      ctx.note({ focusTrail: trail });
      await shot('focus-after-tabs');
    },
  },
  {
    name: 'thread',
    dist: 'fixtures',
    url: '/__fixtures/qa-24',
    async run(page, shot, ctx) {
      await page.locator('textarea').filter({ visible: true }).first().waitFor({ timeout: 60_000 });
      await settle(page, 2000);
      await shot('thread-bottom');
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 800);
      await shot('thread-top');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
      await settle(page, 800);
      await shot('thread-middle');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await settle(page, 800);

      // A turn's actions on hover, then a copy (whose toast is the check).
      const copy = page.locator('[aria-label="Copy"]').filter({ visible: true }).last();
      if (await copy.count()) {
        await copy.hover().catch(() => {});
        await settle(page, 300);
        await shot('turn-actions-hover');
        await tryClick(copy);
        await settle(page, 500);
        await shot('toast');
        await settle(page, 4000);
      }

      // The edit strip: the last question, rewritten in the composer.
      const edited = await page.evaluate(() => {
        const edits = [...document.querySelectorAll('[aria-label="Edit"]')];
        const last = edits[edits.length - 1];
        if (!last) return false;
        last.scrollIntoView({ block: 'center' });
        return true;
      });
      if (edited) {
        const edit = page.locator('[aria-label="Edit"]').last();
        await edit.hover({ force: true }).catch(() => {});
        await edit.click({ force: true, timeout: 4000 }).catch(() => {});
        await settle(page, 800);
        await shot('edit-strip');
        await page.keyboard.press('Escape');
        await settle(page, 500);
        await shot('edit-strip-after-escape');
      }

      // The chat's menu, and what it opens.
      const openMenu = () => tryClick(byLabel(page, 'More options'));
      if (await openMenu()) {
        await settle(page);
        await shot('header-menu');
        await tryClick(byText(page, 'Show panel'));
        await settle(page, 1200);
        await shot('panel-workspace');
        await page.keyboard.press('Escape');
        await settle(page, 600);
      }
      if (await openMenu()) {
        await tryClick(byText(page, 'Usage and context'));
        await settle(page, 1500);
        await shot('panel-usage');
        await page.keyboard.press('Escape');
        await settle(page, 600);
      }
      // A tool row opens the thought panel.
      const toolRow = page.getByText(/^Worked for /).filter({ visible: true }).last();
      if (await toolRow.count()) {
        await toolRow.scrollIntoViewIfNeeded().catch(() => {});
        await tryClick(toolRow);
        await settle(page, 1200);
        await shot('panel-thought');
        await page.keyboard.press('Escape');
        await settle(page, 600);
      }
      if (await openMenu()) {
        await tryClick(byText(page, 'Clear conversation'));
        await settle(page, 800);
        await shot('confirm-dialog');
        await page.keyboard.press('Escape');
        await settle(page, 600);
        await shot('after-confirm-escape');
      }
      if (ctx.width < 1024 && (await openDrawerIfMobile(page))) {
        await shot('drawer-open');
        await closeDrawer(page);
      }
      // An attachment the composer refuses: an empty file, through the add
      // menu's own file picker.
      if (await tryClick(byLabel(page, 'Add attachment'))) {
        await settle(page);
        const chooser = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
        await tryClick(byText(page, 'Files'));
        const picker = await chooser;
        if (picker) {
          await picker.setFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
          await settle(page, 800);
          await shot('attachment-refused');
        } else {
          await page.keyboard.press('Escape');
        }
      }
      await page.evaluate(() => window.__aliaFixture?.threads?.['qa-24']?.stream({ chunks: 20, intervalMs: 40 }));
      await settle(page, 600);
      await shot('after-stream');
    },
  },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const dists = {
    prod: await ensureExport('dist', {}),
    fixtures: await ensureExport('dist-fixtures', { EXPO_PUBLIC_ALIA_FIXTURES: '1' }),
  };
  const servers = {
    prod: await serveExport(dists.prod),
    fixtures: await serveExport(dists.fixtures),
  };
  const engine = args.engine === 'firefox' ? firefox : chromium;
  const browser = await engine.launch({ headless: true });
  const report = [];
  try {
    for (const scenario of SCENARIOS) {
      if (args.only && !scenario.name.includes(args.only)) continue;
      const sizes = [...WIDTHS, ...(scenario.name === 'chat-empty' ? [SHORT] : [])].filter(
        (v) => (!scenario.widths || scenario.widths.includes(v.width)) && (!args.widths || args.widths.includes(v.width)),
      );
      for (const size of sizes) {
        for (const theme of args.themes) {
          const context = await browser.newContext({
            viewport: size,
            deviceScaleFactor: 1,
            colorScheme: theme,
            locale: 'en-US',
            timezoneId: 'UTC',
          });
          await context.route(/(clarity|google-analytics|googletagmanager)/, (route) => route.abort());
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
          const tag = `${scenario.name}_${size.width}x${size.height}_${theme}`;
          const notes = {};
          const shot = async (name) => {
            const file = join(args.out, `${tag}_${name}.png`);
            await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
            const checks = await page.evaluate(inspect);
            report.push({ scenario: scenario.name, shot: name, width: size.width, height: size.height, theme, file, ...checks });
            const flags = [
              checks.overflowX && `overflowX ${checks.scrollWidth}/${checks.clientWidth}`,
              checks.offscreen.length && `offscreen ${checks.offscreen.length}`,
              checks.composerVisible === false && 'composer NOT visible',
              checks.overlapComposer.length && `under composer ${checks.overlapComposer.length}`,
            ].filter(Boolean);
            console.log(`  ${flags.length ? '✗' : '✓'} ${tag}_${name}${flags.length ? ` — ${flags.join(', ')}` : ''}`);
          };
          try {
            await page.goto(`${servers[scenario.dist].origin}${scenario.url}`, { waitUntil: 'load', timeout: 60_000 });
            await scenario.run(page, shot, { ...size, theme, note: (n) => Object.assign(notes, n) });
          } catch (error) {
            console.log(`  ! ${tag}: ${error.message.split('\n')[0]}`);
            notes.error = error.message.split('\n')[0];
          }
          if (errors.length || Object.keys(notes).length) report.push({ scenario: scenario.name, tag, errors, ...notes });
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await Promise.all(Object.values(servers).map((s) => s.close()));
  }
  await writeFile(join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n· ${report.filter((r) => r.shot).length} captures and report.json in ${args.out}`);
}

await main();
