/**
 * The chat workspace, measured on the real component tree with a generated
 * conversation: opening a 1,000-message thread, typing into the composer, a
 * streamed answer, scrolling the whole thread, long tasks across all of it,
 * and memory across repeated conversation switches.
 *
 * The page is `/__fixtures/:id` from `fixtures/` — the chat page
 * (`ChatPageContent`) under the real `(app)` layout, fed by
 * `fixtures/conversation.ts` instead of the API. It exists only in a build
 * made with `EXPO_PUBLIC_ALIA_FIXTURES=1`, exported here into `dist-fixtures/`
 * so it can never be mistaken for, or served as, the production export. Every
 * run also greps the ordinary export in `dist/` and fails if any fixture code
 * reached it.
 *
 * The harness talks to the page through public seams only — a URL, the
 * composer's textarea, the document's scroll, and the fixture's own
 * `window.__aliaFixture` — never through the thread's internals, so it
 * measures the thread as it is today and as it will be after it is windowed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installProbes } from './probes.mjs';
import { describe, quantile, round, slopePerStep } from './stats.mjs';

export const FIXTURES_DIR = 'dist-fixtures';

/** The thread every scenario opens, and the one the switch loop alternates with. */
const LONG = 'a-1000';
const OTHER = 'b-1000';
/** A two-message thread to boot on, so opening LONG is a route change, not a boot. */
const WARM = 'warm-2';

/**
 * Strings that exist only in fixture code and survive minification (property
 * names and literals). Each must be found in the fixtures export — the
 * positive control — and none in the production one.
 */
const FIXTURE_MARKERS = [
  '__aliaFixture',
  '__fixtures/[id]',
  'How do I paginate a Postgres table without OFFSET?',
];

const VIEWPORT = { width: 1280, height: 800 };
const SECONDS_TO_MS = 1000;

function run(command, args, cwd, env) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${code}`)),
    );
  });
}

export async function ensureFixturesExport(appRoot, { rebuild }) {
  const dir = join(appRoot, FIXTURES_DIR);
  if (existsSync(join(dir, 'index.html')) && !rebuild) {
    console.log(`· reusing packages/app/${FIXTURES_DIR} (pass --rebuild to re-export)`);
    return dir;
  }
  console.log('· exporting the fixtures bundle (EXPO_PUBLIC_ALIA_FIXTURES=1)');
  await run(
    'bun',
    ['x', 'expo', 'export', '--platform', 'web', '--output-dir', FIXTURES_DIR],
    appRoot,
    { EXPO_PUBLIC_ALIA_FIXTURES: '1' },
  );
  return dir;
}

async function textFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(js|html|json|map)$/.test(entry.name)) continue;
    out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

/**
 * Which markers each export contains. Throws if the fixtures export lacks one
 * (the grep would prove nothing) or the production export has any.
 */
export async function assertFixturesStayOut(productionDir, fixturesDir) {
  const scan = async (dir) => {
    const found = new Map(FIXTURE_MARKERS.map((m) => [m, []]));
    for (const file of await textFiles(dir)) {
      const text = await readFile(file, 'utf8');
      for (const marker of FIXTURE_MARKERS) if (text.includes(marker)) found.get(marker).push(file);
    }
    return found;
  };
  const inFixtures = await scan(fixturesDir);
  const missing = FIXTURE_MARKERS.filter((m) => inFixtures.get(m).length === 0);
  if (missing.length > 0) {
    throw new Error(`fixtures export lacks ${missing.join(', ')} — the production grep would prove nothing`);
  }
  const inProduction = await scan(productionDir);
  const leaked = FIXTURE_MARKERS.filter((m) => inProduction.get(m).length > 0);
  if (leaked.length > 0) {
    throw new Error(
      `fixture code in the production export: ${leaked
        .map((m) => `${m} in ${inProduction.get(m).join(', ')}`)
        .join('; ')}`,
    );
  }
  return { markers: FIXTURE_MARKERS, clean: true };
}

/** Frame intervals, recorded on the real clock, for a phase that wants them. */
function installFrameRecorder() {
  const raf = window.requestAnimationFrame.bind(window);
  const rec = { on: false, last: 0, deltas: [] };
  const tick = (now) => {
    if (!rec.on) return;
    if (rec.last) rec.deltas.push(now - rec.last);
    rec.last = now;
    raf(tick);
  };
  Object.defineProperty(window, '__frameRec', {
    value: {
      start() {
        rec.on = true;
        rec.last = 0;
        rec.deltas = [];
        raf(tick);
      },
      stop() {
        rec.on = false;
        return rec.deltas.slice();
      },
    },
  });
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  const out = {};
  for (const { name, value } of list) out[name] = value;
  return out;
}

async function heapAfterGc(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  return (await metrics(cdp)).JSHeapUsedSize;
}

async function openContext(browser, origin) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
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
  await context.addInitScript(installProbes, { ctaText: null });
  await context.addInitScript(installFrameRecorder);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  return { context, page, cdp };
}

const waitOpened = (page, id) =>
  page.waitForFunction((key) => window.__aliaFixture?.opened?.[key] !== undefined, id, {
    timeout: 180_000,
    polling: 100,
  });

/**
 * A route change to `/__fixtures/:id`, timed in the page from the navigation to
 * the first frame after the thread committed — the fixture page stamps that
 * moment itself, so nothing here reads the DOM of 1,000 messages to find out.
 *
 * The navigation is the fixture's `navigate`, which is `router.replace` — what
 * the sidebar does to open a chat. It used to be `pushState` + `popstate`, and
 * that is not a chat switch: an entry the router did not write has no state
 * record, so linking calls `resetRoot` with fresh keys and the WHOLE app
 * remounts, `OxyProvider` and its QueryClient included. Every "per-switch"
 * leak the first workspace baseline recorded was that remount (§9 of
 * docs/runtime-baseline.mdx).
 */
const routeToThread = (page, id) =>
  page.evaluate(
    (key) =>
      new Promise((resolve, reject) => {
        delete window.__aliaFixture?.opened?.[key];
        const start = performance.now();
        window.__aliaFixture.navigate(key);
        const check = () => {
          const at = window.__aliaFixture?.opened?.[key];
          if (at !== undefined) resolve(at - start);
          else if (performance.now() - start > 120_000) reject(new Error(`${key} never opened`));
          else setTimeout(check, 5);
        };
        check();
      }),
    id,
  );

/**
 * Runs `body` and prices it: CDP's task, script, layout and style time over
 * it, and the long tasks that started inside it.
 */
async function phase(page, cdp, body) {
  const t0 = await page.evaluate(() => performance.now());
  const before = await metrics(cdp);
  const result = await body();
  const after = await metrics(cdp);
  const t1 = await page.evaluate(() => performance.now());
  const longTasks = await page.evaluate(
    ([from, to]) => window.__perf.longTasks.filter((t) => t.start >= from && t.start <= to),
    [t0, t1],
  );
  const d = (key) => (after[key] - before[key]) * SECONDS_TO_MS;
  return {
    result,
    wallMs: t1 - t0,
    taskMs: d('TaskDuration'),
    scriptMs: d('ScriptDuration'),
    layoutMs: d('LayoutDuration'),
    styleMs: d('RecalcStyleDuration'),
    longTaskCount: longTasks.length,
    longTaskMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
    longTaskMax: longTasks.reduce((max, t) => Math.max(max, t.duration), 0),
    blockingMs: longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
  };
}

function frameStats(deltas) {
  if (deltas.length === 0) return { frames: 0 };
  return {
    frames: deltas.length,
    meanMs: deltas.reduce((s, v) => s + v, 0) / deltas.length,
    p95Ms: quantile(deltas, 0.95),
    maxMs: Math.max(...deltas),
    // A frame that took more than two vsyncs is at least one frame dropped.
    over33ms: deltas.filter((v) => v > 33.4).length,
  };
}

const TYPED = 'How would you window a thread of a thousand messages?';

/**
 * One pass of the whole scenario in a fresh context. Returns every phase's
 * cost; `measureWorkspace` repeats it and takes medians.
 */
async function workspaceRun(browser, origin, { streamChunks, streamIntervalMs, scrollStep }) {
  const { context, page, cdp } = await openContext(browser, origin);
  await page.goto(`${origin}/__fixtures/${WARM}`, { waitUntil: 'commit', timeout: 120_000 });
  await waitOpened(page, WARM);
  await page.waitForTimeout(1000);

  // Open: a route change from the short thread to the long one.
  const open = await phase(page, cdp, () => routeToThread(page, LONG));
  const openSettled = await metrics(cdp);
  const heapOpen = await heapAfterGc(cdp);
  await page.waitForTimeout(500);

  // Typing: real key events into the composer's textarea, one every 60ms.
  const composer = page.locator('textarea').first();
  await composer.click();
  await page.evaluate(() => {
    window.__perf.keyToFrame.length = 0;
    window.__perf.inputEvents.length = 0;
  });
  const typing = await phase(page, cdp, () => page.keyboard.type(TYPED, { delay: 60 }));
  const keys = await page.evaluate(() => ({
    keyToFrame: window.__perf.keyToFrame.slice(),
    events: window.__perf.inputEvents.slice(),
  }));
  await composer.fill('');
  await page.waitForTimeout(300);

  // Streaming: the fixture's simulated turn, flushed like the real stream.
  await page.evaluate(() => window.__frameRec.start());
  const stream = await phase(page, cdp, () =>
    page.evaluate(
      ([id, chunks, intervalMs]) => window.__aliaFixture.threads[id].stream({ chunks, intervalMs }),
      [LONG, streamChunks, streamIntervalMs],
    ),
  );
  const streamFrames = frameStats(await page.evaluate(() => window.__frameRec.stop()));
  await page.waitForTimeout(500);

  // Scroll: jump to the top, then scroll to the bottom `scrollStep` px per frame.
  const scrollSetup = await page.evaluate(() => {
    const doc = document.scrollingElement;
    let scroller = doc;
    if (doc.scrollHeight <= innerHeight + 1000) {
      let best = null;
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (!/(auto|scroll)/.test(style.overflowY)) continue;
        if (el.scrollHeight - el.clientHeight < 1000) continue;
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
      if (best) scroller = best;
    }
    window.__scroller = scroller;
    scroller.scrollTop = 0;
    return { document: scroller === doc, height: scroller.scrollHeight };
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__frameRec.start());
  const scroll = await phase(page, cdp, () =>
    page.evaluate(
      (step) =>
        new Promise((resolve) => {
          const el = window.__scroller;
          let frames = 0;
          const tick = () => {
            const max = el.scrollHeight - el.clientHeight;
            if (el.scrollTop >= max - 1 || frames > 20_000) {
              resolve({ frames, distance: el.scrollTop, height: el.scrollHeight });
              return;
            }
            el.scrollTop = Math.min(max, el.scrollTop + step);
            frames += 1;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      scrollStep,
    ),
  );
  const scrollFrames = frameStats(await page.evaluate(() => window.__frameRec.stop()));

  const total = await page.evaluate(() => ({
    longTasks: window.__perf.longTasks.slice(),
  }));
  const heapEnd = await heapAfterGc(cdp);
  await context.close();

  const events = keys.events.filter((e) => e.name.startsWith('key'));
  return {
    openMs: open.result,
    openTaskMs: open.taskMs,
    openScriptMs: open.scriptMs,
    openLayoutMs: open.layoutMs,
    openStyleMs: open.styleMs,
    openLongTaskMax: open.longTaskMax,
    openNodes: openSettled.Nodes,
    heapAfterOpen: heapOpen,
    keyToFrameMedian: quantile(keys.keyToFrame, 0.5),
    keyToFrameP95: quantile(keys.keyToFrame, 0.95),
    keyToFrameMax: keys.keyToFrame.length ? Math.max(...keys.keyToFrame) : null,
    keystrokes: keys.keyToFrame.length,
    keyEventsOver16: events.length,
    keyEventMax: events.reduce((m, e) => Math.max(m, e.duration), 0),
    typingTaskMsPerKey: typing.taskMs / TYPED.length,
    typingScriptMsPerKey: typing.scriptMs / TYPED.length,
    typingLayoutMsPerKey: typing.layoutMs / TYPED.length,
    typingStyleMsPerKey: typing.styleMs / TYPED.length,
    typingLongTasks: typing.longTaskCount,
    streamUpdates: stream.result.updates,
    streamElapsedMs: stream.result.elapsed,
    streamOverrunMs: stream.result.elapsed - streamChunks * streamIntervalMs,
    streamTaskMsPerUpdate: stream.taskMs / stream.result.updates,
    streamScriptMsPerUpdate: stream.scriptMs / stream.result.updates,
    streamLayoutMsPerUpdate: stream.layoutMs / stream.result.updates,
    streamStyleMsPerUpdate: stream.styleMs / stream.result.updates,
    streamLongTasks: stream.longTaskCount,
    streamBlockingMs: stream.blockingMs,
    streamFps: streamFrames.frames / (stream.wallMs / 1000),
    scrollDocument: scrollSetup.document,
    scrollHeightPx: scroll.result.height,
    scrollFrames: scroll.result.frames,
    scrollWallMs: scroll.wallMs,
    scrollFrameMean: scrollFrames.meanMs,
    scrollFrameP95: scrollFrames.p95Ms,
    scrollFrameMax: scrollFrames.maxMs,
    scrollFramesOver33: scrollFrames.over33ms,
    scrollTaskMs: scroll.taskMs,
    scrollScriptMs: scroll.scriptMs,
    scrollLayoutMs: scroll.layoutMs,
    scrollStyleMs: scroll.styleMs,
    scrollLongTasks: scroll.longTaskCount,
    longTaskCountTotal: total.longTasks.length,
    longTaskMsTotal: total.longTasks.reduce((s, t) => s + t.duration, 0),
    blockingMsTotal: total.longTasks.reduce((s, t) => s + Math.max(0, t.duration - 50), 0),
    heapAtEnd: heapEnd,
  };
}

/**
 * Alternates between two 1,000-message threads `cycles` times in one page,
 * reading the settled heap and the engine's node and listener counts after
 * each. The first two cycles warm caches and are left out of the slope, as in
 * the signed-out leak loop.
 */
async function switchLoop(browser, origin, cycles) {
  const { context, page, cdp } = await openContext(browser, origin);
  await page.goto(`${origin}/__fixtures/${LONG}`, { waitUntil: 'commit', timeout: 120_000 });
  await waitOpened(page, LONG);
  await page.waitForTimeout(1000);

  const sample = async (label) => {
    const heap = await heapAfterGc(cdp);
    const m = await metrics(cdp);
    const live = await page.evaluate(() => window.__perf.live);
    return {
      label,
      heapAfterGc: heap,
      nodes: m.Nodes,
      jsEventListeners: m.JSEventListeners,
      documents: m.Documents,
      timeouts: live.timeouts,
      intervals: live.intervals,
      observers: live.observers,
    };
  };

  const samples = [await sample('start')];
  const switches = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const away = await routeToThread(page, OTHER);
    const back = await routeToThread(page, LONG);
    switches.push({ away, back });
    samples.push(await sample(`cycle ${cycle}`));
    process.stdout.write(`\r  · conversation switches ${cycle}/${cycles}`);
  }
  process.stdout.write('\n');
  await page.waitForTimeout(5000);
  const settled = await sample('settled');
  await context.close();

  const steady = samples.filter((s) => s.label.startsWith('cycle')).slice(2);
  const verdict = {};
  for (const key of ['heapAfterGc', 'nodes', 'jsEventListeners', 'timeouts', 'observers']) {
    const values = steady.map((s) => s[key]);
    verdict[key] = {
      first: values[0] ?? null,
      last: values[values.length - 1] ?? null,
      slopePerCycle: round(slopePerStep(values), 2),
    };
  }
  return {
    cycles,
    switchMs: describe(switches.flatMap((s) => [s.away, s.back])),
    samples: [...samples, settled],
    verdict: { cyclesConsidered: steady.length, counters: verdict },
  };
}

/** Everything, `runs` times over, as medians with their spread. */
export async function measureWorkspace(browser, origin, options) {
  const runs = [];
  for (let i = 0; i < options.runs; i += 1) {
    runs.push(await workspaceRun(browser, origin, options));
    process.stdout.write(`\r  · workspace run ${i + 1}/${options.runs}      `);
  }
  process.stdout.write('\n');
  const summary = {};
  for (const key of Object.keys(runs[0])) {
    if (typeof runs[0][key] === 'number') summary[key] = describe(runs.map((r) => r[key]));
    else summary[key] = runs[0][key];
  }
  const switching = await switchLoop(browser, origin, options.switchCycles);
  return { summary, switching, rawRuns: runs };
}
