/**
 * The runtime baseline for Alia's web surface: what booting it actually costs,
 * and whether repeatedly mounting and unmounting a screen leaks.
 *
 * Required by #608 §12, which asks for a reproducible baseline of "inicio …
 * tiempo de interacción y costes de render/JS/UI, memoria y recursos activos"
 * and for "sin crecimiento continuado de sockets, tracks, listeners, timers,
 * object URLs ni memoria". One command:
 *
 *     bun run --filter @alia/app perf:baseline
 *
 * Flags:
 *     --check          Measure into a temp file and COMPARE against the
 *                      committed baseline instead of overwriting it. Exits
 *                      non-zero if a median moved by more than the noise
 *                      threshold.
 *     --runs <n>       Measured boot runs per CPU rate (default 7).
 *     --warmup <n>     Discarded runs before them (default 1).
 *     --cycles <n>     Mount/unmount cycles in the leak loop (default 12).
 *     --rates <list>   CPU throttling rates, comma separated (default "1,4").
 *     --rebuild        Re-run `expo export` even if `dist/` already exists.
 *
 * ## Why this is a second harness and not a flag on the first
 *
 * `scripts/visual/` owns the animation clock: it hands every
 * `requestAnimationFrame` callback a virtual timestamp and replays the screen
 * frame by frame. That is exactly what makes its pixels reproducible and
 * exactly why no timing can be read off it — in that harness "6000ms" is a
 * position in an animation, not an elapsed time. This harness installs no clock
 * at all. It shares the static server (`scripts/visual/server.mjs`), the
 * network blocking and the Chromium setup, and nothing else.
 *
 * ## What it can honestly reach
 *
 * There is no authentication and no live API here, so this measures the
 * signed-out surface: the boot of the web bundle, the welcome intro over the
 * app chrome, and route changes between two screens that render signed out.
 * Conversation, typing, streaming, scroll, panels and the call — the rest of
 * §12 — are not measured and are not measurable without a session. The doc
 * (`docs/runtime-baseline.mdx`) lists them explicitly rather than quietly
 * leaving them out.
 */
import { spawn } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
// The visual harness's static server, reused rather than reimplemented. It is
// imported, never modified.
import { serveExport } from '../visual/server.mjs';
import { installProbes } from './probes.mjs';
import { describe, formatStat, round, slopePerStep, table } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '../..');
const DIST = join(APP_ROOT, 'dist');
const BASELINE = join(HERE, 'baseline');
const BASELINE_FILE = join(BASELINE, 'runtime.json');

/**
 * The single viewport.
 *
 * The visual baseline needs six because a layout looks different at each one.
 * A boot cost does not: the bundle, the parse, the evaluation and the first
 * render are the same work at 320px and at 1440px, and measuring six viewports
 * would multiply a ten-minute run by six to produce six copies of one number
 * with six independent noise draws. 1280x800 is the reference desktop, and it
 * is the size at which the drawer and the composer are both mounted, so it is
 * the most work the signed-out surface ever does.
 */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * How long the screen is watched, after it has settled, to price an idle frame.
 *
 * This screen never stops animating — `ambient-field.tsx` runs unbounded
 * `withRepeat` loops — so "idle" here means "nobody is touching it", not "no
 * work is happening". Two seconds is enough for a stable frames-per-second and
 * a main-thread cost that is well above the metric's own resolution.
 */
const IDLE_WINDOW_MS = 2000;

/** How long the leak loop is left alone before its final counter sample. */
const SETTLE_MS = 5000;

/**
 * The noise thresholds: below these, a difference between two runs of this
 * harness is the machine, not the code.
 *
 * Calibrated, not guessed. Three full sets were measured back to back on the
 * same machine and their medians compared; the worst drift on any timing was
 * 13.7%, and on the settled heap 0.1%. The derivation is in
 * `docs/runtime-baseline.mdx`.
 *
 * Two thresholds rather than one, because one would be wrong for both: a 20%
 * gate on a heap figure that reproduces to a tenth of a percent would wave
 * through a five-megabyte regression, and a 3% gate on a boot time whose own
 * medians wander by 13% would cry wolf on every run.
 */
const NOISE_THRESHOLDS = { default: 20, heapAfterGc: 3 };

/** Timing metrics that `--check` compares. Counters are compared exactly. */
const CHECKED_METRICS = [
  'firstPaint',
  'firstContentfulPaint',
  'appFirstRender',
  'ctaInteractive',
  'scriptDuration',
  'taskDuration',
  'totalBlockingTime',
  'heapAfterGc',
];

const thresholdFor = (metric) => NOISE_THRESHOLDS[metric] ?? NOISE_THRESHOLDS.default;

function parseArgs(argv) {
  const args = {
    check: false,
    rebuild: false,
    runs: 7,
    warmup: 1,
    cycles: 12,
    rates: [1, 4],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--rebuild') args.rebuild = true;
    else if (arg === '--runs') args.runs = Number(argv[(i += 1)]);
    else if (arg === '--warmup') args.warmup = Number(argv[(i += 1)]);
    else if (arg === '--cycles') args.cycles = Number(argv[(i += 1)]);
    else if (arg === '--rates') args.rates = argv[(i += 1)].split(',').map(Number);
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
    return;
  }
  console.log('· exporting the web bundle — a few minutes');
  await run('bun', ['x', 'setup-skia-web', 'public'], APP_ROOT);
  await run('bun', ['x', 'expo', 'export', '--platform', 'web'], APP_ROOT);
}

/**
 * The copy the probes wait for, read from the translations rather than
 * hardcoded — the same reason as in the visual harness: a signal built on a
 * literal string rots silently when the copy changes, and a rotted signal here
 * does not fail, it times out after a minute and looks like a slow boot.
 */
async function copy() {
  const en = JSON.parse(await readFile(join(APP_ROOT, 'lib/i18n/locales/en.json'), 'utf8'));
  return {
    cta: en.welcome.intro.cta,
    greeting: en.welcome.greeting,
  };
}

/** CDP's metric list as an object, with the second-valued fields in ms. */
async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  /** @type {Record<string, number>} */
  const out = {};
  for (const { name, value } of list) out[name] = value;
  return out;
}

const SECONDS_TO_MS = 1000;

/**
 * Forces a collection and reads the heap.
 *
 * Without the collection the number is "whatever had not been swept yet", which
 * drifts by tens of megabytes between runs and makes a leak test meaningless.
 * With it, the figure is live, reachable memory — the only heap number worth
 * comparing across cycles.
 */
async function heapAfterGc(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await metrics(cdp);
  return after.JSHeapUsedSize;
}

/** One measured boot, in a context of its own. */
async function bootRun(browser, origin, text, rate) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  // Same rule as the visual harness: nothing but the local export answers. A
  // boot that waited on the Oxy API would be measuring that day's network.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(installProbes, { ctaText: text.cta });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });

  // `commit` rather than `load`: every moment this run reports is timed inside
  // the page against its own navigation start, so waiting for the load event
  // here would only delay the harness, not change a number.
  await page.goto(`${origin}/`, { waitUntil: 'commit', timeout: 120_000 });
  await page.waitForFunction(() => window.__perf.marks.ctaInteractive !== null, undefined, {
    timeout: 180_000,
    polling: 'raf',
  });

  const atCta = await metrics(cdp);

  // Price an idle frame: how much main thread a screen that nobody is touching
  // still costs, because this one never stops animating.
  const beforeIdle = await metrics(cdp);
  const idle = await page.evaluate((ms) => window.__perf.countFrames(ms), IDLE_WINDOW_MS);
  const afterIdle = await metrics(cdp);

  const snapshot = await page.evaluate(() => window.__perf.snapshot());
  const heap = await heapAfterGc(cdp);
  const settled = await metrics(cdp);

  await context.close();

  const ctaAt = snapshot.marks.ctaInteractive;
  const beforeCta = snapshot.longTasks.filter((t) => t.start <= ctaAt);
  // Total blocking time: the part of each long task beyond the 50ms a frame is
  // allowed. It is the number that tracks "the page was wedged", which raw task
  // count does not — ten 51ms tasks are not one 500ms stall.
  const blocking = beforeCta.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0);

  return {
    rate,
    firstPaint: snapshot.paint['first-paint'] ?? null,
    firstContentfulPaint: snapshot.paint['first-contentful-paint'] ?? null,
    largestContentfulPaint: snapshot.paint['largest-contentful-paint'] ?? null,
    domContentLoaded: snapshot.navigation?.domContentLoadedEventEnd ?? null,
    loadEvent: snapshot.navigation?.loadEventEnd ?? null,
    appFirstRender: snapshot.marks.appFirstRender,
    ctaInteractive: ctaAt,
    longTaskCount: beforeCta.length,
    longTaskMax: beforeCta.reduce((max, t) => Math.max(max, t.duration), 0),
    totalBlockingTime: blocking,
    scriptDuration: atCta.ScriptDuration * SECONDS_TO_MS,
    layoutDuration: atCta.LayoutDuration * SECONDS_TO_MS,
    recalcStyleDuration: atCta.RecalcStyleDuration * SECONDS_TO_MS,
    taskDuration: atCta.TaskDuration * SECONDS_TO_MS,
    layoutCount: atCta.LayoutCount,
    recalcStyleCount: atCta.RecalcStyleCount,
    nodes: settled.Nodes,
    jsEventListeners: settled.JSEventListeners,
    heapAtCta: atCta.JSHeapUsedSize,
    heapAfterGc: heap,
    idleFps: (idle.frames / idle.elapsed) * 1000,
    idleTaskMsPerSecond:
      ((afterIdle.TaskDuration - beforeIdle.TaskDuration) * SECONDS_TO_MS) / (idle.elapsed / 1000),
    idleScriptMsPerSecond:
      ((afterIdle.ScriptDuration - beforeIdle.ScriptDuration) * SECONDS_TO_MS) /
      (idle.elapsed / 1000),
    scriptBytes: snapshot.scripts.decodedBytes,
    scriptRequests: snapshot.scripts.count,
    liveAtBoot: snapshot.live,
    totalsAtBoot: snapshot.totals,
  };
}

/**
 * The leak loop: mount and unmount a screen `cycles` times in ONE page and
 * watch the counters.
 *
 * The navigation is `pushState` + `popstate` rather than a click, because it is
 * the router's own web transport — React Navigation's linking subscribes to
 * `popstate` — and it needs no button to exist at a known place on two
 * different screens. It is a real route change: the home route's whole subtree
 * unmounts, `/download` mounts, and back again. A `page.reload()` loop would be
 * useless here; it throws the JS heap away every cycle and so can never show a
 * component leak.
 */
async function leakLoop(browser, origin, text, cycles) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(installProbes, { ctaText: text.cta });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  // No CPU throttling here: this loop compares counters against each other
  // inside one session, so slowing the machine down would buy nothing but
  // twenty extra minutes.

  await page.goto(`${origin}/`, { waitUntil: 'commit', timeout: 120_000 });
  await page.waitForFunction(() => window.__perf.marks.ctaInteractive !== null, undefined, {
    timeout: 180_000,
    polling: 'raf',
  });

  const navigate = (path, expected) =>
    page.evaluate(([to, needle]) => window.__perf.routeTo(to, needle), [path, expected]);

  const sample = async (label) => {
    const heap = await heapAfterGc(cdp);
    const now = await metrics(cdp);
    const live = await page.evaluate(() => ({
      live: window.__perf.live,
      totals: window.__perf.totals,
    }));
    return {
      label,
      heapAfterGc: heap,
      nodes: now.Nodes,
      jsEventListeners: now.JSEventListeners,
      documents: now.Documents,
      ...live.live,
      listenersAdded: live.totals.listenersAdded,
      listenersRemoved: live.totals.listenersRemoved,
    };
  };

  /** @type {Awaited<ReturnType<typeof sample>>[]} */
  const samples = [await sample('start')];
  /** @type {{ away: number, back: number }[]} */
  const routeTimings = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const away = await navigate('/download', text.downloadMarker);
    const back = await navigate('/', text.greeting);
    routeTimings.push({ away, back });
    samples.push(await sample(`cycle ${cycle}`));
    process.stdout.write(`\r  · leak loop ${cycle}/${cycles}`);
  }
  process.stdout.write('\n');

  // One last sample after five idle seconds. Counters sampled the instant a
  // route finishes mounting catch timers that were scheduled by that mount and
  // have not fired yet, which looks exactly like a leak; a sample taken once
  // the screen has been left alone separates "still pending" from "never going
  // away".
  await page.evaluate((ms) => new Promise((done) => setTimeout(done, ms)), SETTLE_MS);
  const settled = await sample('settled');

  await context.close();
  return { samples, settled, routeTimings };
}

/**
 * The verdict on each counter.
 *
 * The first two cycles are dropped from the slope: the first route change
 * fetches and evaluates `/download`'s lazy chunk and warms caches that never
 * cool again, so including them measures a one-off cost as if it were a trend.
 * What is left is the steady state, which is where a leak lives.
 */
function leakVerdict(samples) {
  const steady = samples.filter((s) => s.label.startsWith('cycle')).slice(2);
  const series = (key) => steady.map((s) => s[key]);
  const counters = [
    'heapAfterGc',
    'nodes',
    'jsEventListeners',
    'listeners',
    'intervals',
    'timeouts',
    'objectUrls',
    'observers',
    'sockets',
    'documents',
  ];
  /** @type {Record<string, { first: number, last: number, slopePerCycle: number }>} */
  const out = {};
  for (const key of counters) {
    const values = series(key);
    out[key] = {
      first: values[0] ?? null,
      last: values[values.length - 1] ?? null,
      slopePerCycle: round(slopePerStep(values), 2),
    };
  }
  return { cyclesConsidered: steady.length, counters: out };
}

/**
 * Compares a fresh measurement against the committed baseline, median by
 * median, each against its own threshold.
 *
 * @param {{ boot: Record<string, Record<string, { median: number }>> }} previous
 * @param {{ boot: Record<string, Record<string, { median: number }>> }} current
 */
function compare(previous, current) {
  const rows = [['metric', 'baseline', 'now', 'Δ%', 'gate', '']];
  let failures = 0;
  for (const rate of Object.keys(current.boot)) {
    for (const metric of CHECKED_METRICS) {
      const was = previous.boot?.[rate]?.[metric]?.median;
      const now = current.boot[rate][metric]?.median;
      if (typeof was !== 'number' || typeof now !== 'number') continue;
      const delta = was === 0 ? 0 : ((now - was) / was) * 100;
      const gate = thresholdFor(metric);
      const ok = Math.abs(delta) <= gate;
      if (!ok) failures += 1;
      rows.push([
        `${rate} ${metric}`,
        round(was, 1),
        round(now, 1),
        `${delta > 0 ? '+' : ''}${round(delta, 1)}%`,
        `±${gate}%`,
        ok ? 'ok' : 'OUTSIDE',
      ]);
    }
  }
  return { rows, failures };
}

/** Bytes → MiB, keeping the shape `formatStat` expects. */
function inMebibytes(stat) {
  if (!stat) return null;
  const scale = (v) => (typeof v === 'number' ? v / 1024 / 1024 : v);
  return {
    ...stat,
    median: scale(stat.median),
    min: scale(stat.min),
    max: scale(stat.max),
    p25: scale(stat.p25),
    p75: scale(stat.p75),
    iqr: scale(stat.iqr),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureExport(args);

  const text = await copy();
  // The marker for the other route in the leak loop. It is a heading on
  // `app/(biglayout)/download.tsx`, which is one of the few screens that render
  // fully signed out.
  text.downloadMarker = 'Get Alia on your phone';

  // The load average, at the start and again at the end.
  //
  // Not decoration. Every timing here is a measurement of a shared machine, and
  // a set taken while something else was compiling is not comparable with one
  // taken on a quiet host — measured, not assumed: the same harness run four
  // times on this machine produced medians 13% apart while it was idle and 75%
  // apart while four other headless browsers were running. Recording the load
  // is what lets a later reader tell those two cases apart instead of
  // discovering a phantom regression.
  const loadAtStart = loadavg();
  const cores = cpus().length;
  if (loadAtStart[0] > cores / 4) {
    console.log(
      `! load average is ${loadAtStart[0].toFixed(1)} on ${cores} cores — this machine is busy,` +
        ' and every timing below will be inflated and noisy',
    );
  }

  const server = await serveExport(DIST);
  const browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  console.log(`· chromium ${chromiumVersion} on ${server.origin}`);
  console.log(
    `· ${args.warmup} warm-up + ${args.runs} measured boots at CPU rate ${args.rates.join('x, ')}x` +
      `, then ${args.cycles} mount/unmount cycles`,
  );

  /** @type {Record<string, object>} */
  const boot = {};
  /** @type {Record<string, object[]>} */
  const rawRuns = {};
  let leak;

  try {
    for (const rate of args.rates) {
      /** @type {Awaited<ReturnType<typeof bootRun>>[]} */
      const runs = [];
      for (let i = 0; i < args.warmup; i += 1) {
        // Discarded on purpose. The first boot in a browser process pays for
        // V8's code cache being cold and for Chromium's own lazy initialisation,
        // and it is reliably the slowest run of any set.
        await bootRun(browser, server.origin, text, rate);
        process.stdout.write(`\r  · ${rate}x warm-up ${i + 1}/${args.warmup}`);
      }
      for (let i = 0; i < args.runs; i += 1) {
        runs.push(await bootRun(browser, server.origin, text, rate));
        process.stdout.write(`\r  · ${rate}x run ${i + 1}/${args.runs}      `);
      }
      process.stdout.write('\n');

      const key = `${rate}x`;
      rawRuns[key] = runs;
      const stat = (field) => describe(runs.map((r) => r[field]));
      boot[key] = {
        firstPaint: stat('firstPaint'),
        firstContentfulPaint: stat('firstContentfulPaint'),
        largestContentfulPaint: stat('largestContentfulPaint'),
        domContentLoaded: stat('domContentLoaded'),
        loadEvent: stat('loadEvent'),
        appFirstRender: stat('appFirstRender'),
        ctaInteractive: stat('ctaInteractive'),
        longTaskCount: stat('longTaskCount'),
        longTaskMax: stat('longTaskMax'),
        totalBlockingTime: stat('totalBlockingTime'),
        scriptDuration: stat('scriptDuration'),
        layoutDuration: stat('layoutDuration'),
        recalcStyleDuration: stat('recalcStyleDuration'),
        taskDuration: stat('taskDuration'),
        layoutCount: stat('layoutCount'),
        nodes: stat('nodes'),
        jsEventListeners: stat('jsEventListeners'),
        heapAtCta: stat('heapAtCta'),
        heapAfterGc: stat('heapAfterGc'),
        idleFps: stat('idleFps'),
        idleTaskMsPerSecond: stat('idleTaskMsPerSecond'),
        idleScriptMsPerSecond: stat('idleScriptMsPerSecond'),
        scriptBytes: stat('scriptBytes'),
        scriptRequests: stat('scriptRequests'),
        // How much of "time to the button" is the designed entrance rather
        // than engineering cost: the intro's own choreography is a 700ms delay
        // plus a 400ms fade, and it does not start until the app first renders.
        ctaMinusFirstRender: describe(runs.map((r) => r.ctaInteractive - r.appFirstRender)),
        liveAtBoot: runs[runs.length - 1].liveAtBoot,
        totalsAtBoot: runs[runs.length - 1].totalsAtBoot,
      };
    }

    leak = await leakLoop(browser, server.origin, text, args.cycles);
  } finally {
    await browser.close();
    await server.close();
  }

  const report = {
    note:
      'Written by packages/app/scripts/perf/measure.mjs. Regenerate with ' +
      '`bun run --filter @alia/app perf:baseline`; verify with the same command plus --check. ' +
      'Read docs/runtime-baseline.mdx before quoting any of this.',
    measuredAt: new Date().toISOString(),
    chromium: chromiumVersion,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: cores,
      node: process.version,
      loadAverageAtStart: loadAtStart.map((v) => round(v, 2)),
      loadAverageAtEnd: loadavg().map((v) => round(v, 2)),
    },
    pinned: {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
      network: 'everything but the local static server is aborted',
      cpuThrottlingRates: args.rates,
      warmupRuns: args.warmup,
      measuredRuns: args.runs,
      idleWindowMs: IDLE_WINDOW_MS,
      leakCycles: args.cycles,
      surface: 'signed out, no API: welcome intro over the app chrome at /',
    },
    noiseThresholdsPct: NOISE_THRESHOLDS,
    boot,
    routeChange: {
      // The first cycle fetches and evaluates `/download`'s lazy chunk, so it
      // is a different measurement from the eleven that follow and is reported
      // on its own rather than folded into the median.
      firstAway: round(leak.routeTimings[0]?.away, 1),
      away: describe(leak.routeTimings.slice(1).map((t) => t.away)),
      back: describe(leak.routeTimings.slice(1).map((t) => t.back)),
    },
    leak: {
      samples: [...leak.samples, leak.settled],
      settled: leak.settled,
      verdict: leakVerdict(leak.samples),
    },
  };
  const summary = [];
  for (const [rate, stats] of Object.entries(boot)) {
    summary.push('', `CPU rate ${rate}`);
    summary.push(
      table([
        ['first paint', formatStat(stats.firstPaint)],
        ['first contentful paint', formatStat(stats.firstContentfulPaint)],
        ['app first render', formatStat(stats.appFirstRender)],
        ['CTA hittable', formatStat(stats.ctaInteractive)],
        ['script duration', formatStat(stats.scriptDuration)],
        ['task duration', formatStat(stats.taskDuration)],
        ['total blocking time', formatStat(stats.totalBlockingTime)],
        ['long tasks before CTA', formatStat(stats.longTaskCount, '')],
        ['longest task', formatStat(stats.longTaskMax)],
        ['heap after GC', formatStat(inMebibytes(stats.heapAfterGc), ' MiB')],
        ['idle fps', formatStat(stats.idleFps, 'fps')],
        ['idle main thread', formatStat(stats.idleTaskMsPerSecond, 'ms/s')],
        ['entrance choreography', formatStat(stats.ctaMinusFirstRender)],
      ]),
    );
  }
  console.log(summary.join('\n'));
  console.log('\nroute change (signed out, no API)');
  console.log(
    table([
      ['/ → /download, first (chunk cold)', `${report.routeChange.firstAway}ms`],
      ['/ → /download, after', formatStat(report.routeChange.away)],
      ['/download → /', formatStat(report.routeChange.back)],
    ]),
  );

  const verdict = report.leak.verdict;
  console.log('\nleak loop, steady state over', verdict.cyclesConsidered, 'cycles');
  console.log(
    table([
      ['counter', 'first', 'last', 'slope/cycle', 'after 5s idle'],
      ...Object.entries(verdict.counters).map(([key, v]) => [
        key,
        v.first,
        v.last,
        v.slopePerCycle,
        report.leak.settled[key],
      ]),
    ]),
  );

  if (args.check) {
    if (!existsSync(BASELINE_FILE)) {
      console.error('\nno committed baseline to check against');
      process.exitCode = 1;
      return;
    }
    const previous = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
    const { rows, failures } = compare(previous, report);
    console.log('\nagainst the committed baseline');
    console.log(table(rows));
    if (failures > 0) {
      console.error(`\n${failures} metric(s) outside the noise threshold`);
      process.exitCode = 1;
    }
    return;
  }

  await mkdir(BASELINE, { recursive: true });
  await writeFile(BASELINE_FILE, `${JSON.stringify({ ...report, rawRuns }, null, 2)}\n`);
  console.log(`\n· wrote ${BASELINE_FILE}`);
}

await main();
