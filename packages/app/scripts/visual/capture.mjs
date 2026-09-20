/**
 * The visual and motion baseline for Alia's web surface.
 *
 * Required by #608 §3.1 (visual + motion reference before the chat refactor
 * goes further), §12 (reproducible bundle baseline and the viewport matrix) and
 * §13 (comparison evidence). One command:
 *
 *     bun run --filter @alia/app visual:baseline
 *
 * Flags:
 *     --check          Capture into a temp directory and compare against the
 *                      committed `baseline/` instead of overwriting it. This is
 *                      both the determinism proof and the regression gate.
 *     --rebuild        Re-run `expo export` even if `dist/` already exists.
 *     --only <text>    Capture only cases whose name contains `text`.
 *     --tolerance <n>  Override the per-channel tolerance (default 4).
 *
 * Everything this pins, and why, is in `docs/visual-baseline.mdx`.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveExport } from './server.mjs';
import { installVirtualClock, playTo, VIRTUAL_FRAME_MS } from './clock.mjs';
import { comparePngs } from './png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '../..');
const DIST = join(APP_ROOT, 'dist');
const BASELINE = join(HERE, 'baseline');

/**
 * The per-channel tolerance.
 *
 * Not zero, and it cannot be. The screen is a 70px blur over three blended SVG
 * radial gradients, and Chromium's blur is separable-convolution arithmetic
 * whose last bit depends on the tile boundaries the compositor happened to
 * pick. Two runs of the identical frame, same clock, same viewport, agree on
 * the composition and disagree on the low bits of a few pixels.
 *
 * Measured, capturing the matrix twice back to back: 24 of the 28 cases came
 * back byte-identical, and the four that moved were
 *
 *   390x844 dark motion     Δ4 over 20 px
 *   390x844 dark reduced    Δ3 over 42 px
 *   1280x800 light reduced  Δ3 over  8 px
 *   390x844 light reduced   Δ2 over 37 px
 *
 * out of 329,160 pixels in the largest of them. So the worst observed is 4, and
 * the gate is 6: two bits of headroom over the noise floor, 2% of the channel
 * range, and still orders of magnitude below any change worth catching. A moved
 * element, a changed token or a different face does not nudge a few dozen
 * pixels by 4 — it moves thousands of pixels by tens or hundreds, which this
 * fails on both counts.
 */
const TOLERANCE = 6;

/**
 * The §12 viewport matrix. Widths are #608's; the heights are the ordinary
 * companion for each width and are pinned here because a screenshot has to have
 * one — 320x568 is the smallest phone still in the matrix, 1440x900 the
 * reference desktop.
 */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

/**
 * The canonical virtual instant every still is taken at.
 *
 * The ambient field's entrance is a 2400ms tween behind delays of 850, 1030 and
 * 1190ms, so the last blob comes to rest at 3590ms. 6000ms is comfortably past
 * that and 2410ms into the float loops (8000 / 11000 / 9500ms), which is a
 * frame where the field is unmistakably drifting rather than one where it
 * happens to sit at its origin.
 */
const REST_AT = 6000;

/**
 * Extra instants, captured at one size only, purely as motion evidence: mid
 * entrance, the moment the entrance ends, and deep into the float.
 */
const MOTION_FRAMES = [1200, 2400, 3590, 9000];

/** Pinned wall clock, so anything that renders a date renders the same one. */
const EPOCH = Date.UTC(2026, 0, 1, 12, 0, 0);

function parseArgs(argv) {
  const args = { check: false, rebuild: false, only: null, tolerance: TOLERANCE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--rebuild') args.rebuild = true;
    else if (arg === '--only') args.only = argv[(i += 1)];
    else if (arg === '--tolerance') args.tolerance = Number(argv[(i += 1)]);
  }
  return args;
}

function run(command, commandArgs, cwd) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function ensureExport({ rebuild }) {
  if (existsSync(join(DIST, 'index.html')) && !rebuild) {
    console.log('· reusing packages/app/dist (pass --rebuild to re-export)');
    return false;
  }
  console.log('· exporting the web bundle — a few minutes');
  await run('bun', ['x', 'setup-skia-web', 'public'], APP_ROOT);
  await run('bun', ['x', 'expo', 'export', '--platform', 'web'], APP_ROOT);
  return true;
}

/** The §12 numbers, straight off the export. */
async function bundleStats() {
  const jsDir = join(DIST, '_expo/static/js/web');
  const cssDir = join(DIST, '_expo/static/css');

  async function sizes(dir, suffix) {
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir)).filter((n) => n.endsWith(suffix));
    return Promise.all(
      names.map(async (name) => ({ name, bytes: (await stat(join(dir, name))).size })),
    );
  }

  const js = (await sizes(jsDir, '.js')).sort((a, b) => b.bytes - a.bytes);
  const css = await sizes(cssDir, '.css');
  const total = (list) => list.reduce((sum, f) => sum + f.bytes, 0);

  return {
    jsChunks: js.length,
    jsTotalBytes: total(js),
    largestJsChunks: js.slice(0, 10),
    cssFiles: css.length,
    cssTotalBytes: total(css),
  };
}

/**
 * The headline is read from the translations rather than hardcoded, so the
 * "typing has finished" signal cannot silently rot when the copy changes.
 */
async function welcomeCopy() {
  const en = JSON.parse(await readFile(join(APP_ROOT, 'lib/i18n/locales/en.json'), 'utf8'));
  return en.welcome.intro;
}

/**
 * Every case in the matrix.
 *
 * @param {{ headline: string }} copy
 */
function buildCases() {
  const cases = [];
  for (const viewport of VIEWPORTS) {
    for (const colorScheme of ['light', 'dark']) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const motion = reducedMotion === 'reduce' ? 'reduced' : 'motion';
        cases.push({
          name: `welcome_${viewport.width}x${viewport.height}_${colorScheme}_${motion}`,
          viewport,
          colorScheme,
          reducedMotion,
          at: REST_AT,
        });
      }
    }
  }
  // Motion evidence: one size, one scheme, four instants on the field's own
  // timeline. Capturing this at every size would multiply the matrix for no
  // extra information — the timeline is identical, only the frame differs.
  for (const at of MOTION_FRAMES) {
    cases.push({
      name: `ambient_1280x800_light_motion_t${String(at).padStart(5, '0')}`,
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      at,
    });
  }
  return cases;
}

/**
 * Loads the welcome screen, freezes it at `at`, and returns the PNG.
 *
 * @param {import('playwright-core').Browser} browser
 * @param {string} origin
 */
async function captureCase(browser, origin, testCase, copy) {
  const context = await browser.newContext({
    viewport: testCase.viewport,
    // A fractional scale factor would resample the blur differently on every
    // machine; 1 keeps a CSS pixel a device pixel.
    deviceScaleFactor: 1,
    colorScheme: testCase.colorScheme,
    reducedMotion: testCase.reducedMotion,
    locale: 'en-US',
    timezoneId: 'UTC',
    // Not `isMobile`: the export is a desktop-web build and touch emulation
    // changes which branch of the layout renders, which is a different subject,
    // not a different rendering of this one.
  });

  // No network but the export itself. This is a signed-out capture against a
  // static bundle; letting a font CDN or the Oxy API answer would make the
  // picture depend on what those services returned today.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });

  await context.addInitScript(installVirtualClock, { epoch: EPOCH, frameMs: VIRTUAL_FRAME_MS });

  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 60_000 });

  // Signal 1: the headline has finished typing itself. It is revealed one
  // character every 55ms by `setInterval`, which is REAL time — the virtual
  // clock deliberately does not touch timers — so this is the one thing that
  // has to be waited for rather than seeked to.
  await page.waitForFunction(
    (headline) =>
      [...document.querySelectorAll('[aria-label]')].some(
        (el) =>
          el.getAttribute('aria-label') === headline && el.textContent?.trim() === headline,
      ),
    copy.headline,
    { timeout: 60_000 },
  );

  // Fonts before pixels: text measured in a fallback face and then reflowed is
  // the classic non-deterministic screenshot.
  await page.evaluate(() => document.fonts.ready);

  await playTo(page, testCase.at);

  // Signal 2, after the seek: the body reveal animates from 0 to a MEASURED
  // height, and the component writes no height at all until that measurement
  // lands. An inline, non-zero height on a clipping box is therefore proof that
  // the subtitle and the call to action were laid out and are on screen.
  if (testCase.at >= 800) {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('div')].some(
          (el) =>
            el.style.height &&
            parseFloat(el.style.height) > 0 &&
            getComputedStyle(el).overflow === 'hidden',
        ),
      undefined,
      { timeout: 30_000 },
    );
  }

  const png = await page.screenshot({
    // Reanimated drives this screen from `requestAnimationFrame`, which the
    // virtual clock owns. This setting covers the other half: CSS transitions
    // and Web Animations, which NativeWind and Bloom do use.
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });

  await context.close();
  return png;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureExport(args);

  const copy = await welcomeCopy();
  const stats = await bundleStats();
  const cases = buildCases().filter((c) => !args.only || c.name.includes(args.only));

  const outDir = args.check
    ? await mkdtemp(join(tmpdir(), 'alia-visual-'))
    : (await mkdir(BASELINE, { recursive: true }), BASELINE);

  const server = await serveExport(DIST);
  const browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  console.log(`· chromium ${chromiumVersion} on ${server.origin}`);

  /** @type {{name: string, bytes: number, comparison?: object}[]} */
  const captured = [];
  let failures = 0;

  try {
    for (const testCase of cases) {
      const png = await captureCase(browser, server.origin, testCase, copy);
      const file = join(outDir, `${testCase.name}.png`);
      await writeFile(file, png);

      if (args.check) {
        const reference = join(BASELINE, `${testCase.name}.png`);
        if (!existsSync(reference)) {
          console.log(`  ✗ ${testCase.name} — no committed baseline`);
          failures += 1;
          continue;
        }
        const result = comparePngs(await readFile(reference), png, args.tolerance);
        captured.push({ name: testCase.name, bytes: png.length, comparison: result });
        if (result.ok) {
          console.log(
            `  ✓ ${testCase.name} — max Δ${result.maxDelta}, ${result.changed} px moved at all`,
          );
        } else {
          failures += 1;
          console.log(
            `  ✗ ${testCase.name} — ${result.reason ?? ''} max Δ${result.maxDelta}` +
              ` at (${result.worst?.x}, ${result.worst?.y}), ${result.offending} px over ±${args.tolerance}`,
          );
        }
      } else {
        captured.push({ name: testCase.name, bytes: png.length });
        console.log(`  ✓ ${testCase.name} — ${(png.length / 1024).toFixed(0)} KB`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (!args.check) {
    await writeFile(
      join(BASELINE, 'manifest.json'),
      `${JSON.stringify(
        {
          note:
            'Written by packages/app/scripts/visual/capture.mjs. Regenerate with ' +
            '`bun run --filter @alia/app visual:baseline`; verify with the same command plus --check.',
          capturedAt: new Date().toISOString(),
          chromium: chromiumVersion,
          pinned: {
            deviceScaleFactor: 1,
            locale: 'en-US',
            timezoneId: 'UTC',
            epoch: new Date(EPOCH).toISOString(),
            virtualFrameMs: VIRTUAL_FRAME_MS,
            virtualClockRestMs: REST_AT,
            motionFrameMs: MOTION_FRAMES,
            network: 'everything but the local static server is aborted',
            screenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
          },
          tolerance: TOLERANCE,
          viewports: VIEWPORTS,
          bundle: stats,
          files: captured.map((c) => ({ name: `${c.name}.png`, bytes: c.bytes })),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\n· ${captured.length} PNGs in ${BASELINE}`);
    console.log(
      `· bundle: ${stats.jsChunks} JS chunks, ${(stats.jsTotalBytes / 1024 / 1024).toFixed(2)} MB total`,
    );
  } else {
    await rm(outDir, { recursive: true, force: true });
    const worst = captured.reduce((max, c) => Math.max(max, c.comparison?.maxDelta ?? 0), 0);
    console.log(`\n· worst per-channel delta across the matrix: ${worst} (tolerance ±${args.tolerance})`);
  }

  if (failures > 0) {
    console.error(`\n${failures} case(s) outside tolerance`);
    process.exitCode = 1;
  }
}

await main();
