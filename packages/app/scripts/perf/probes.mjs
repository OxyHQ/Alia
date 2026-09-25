/**
 * The in-page instrumentation for the runtime baseline.
 *
 * This is the opposite of `scripts/visual/clock.mjs`. That one REPLACES the
 * clock so pixels are reproducible; nothing timed can be read off it. This one
 * touches no clock at all — `performance.now()`, `Date.now()` and the
 * `requestAnimationFrame` timestamp are the browser's own — and only watches.
 *
 * Installed with `addInitScript`, so it is in place before the first bundle
 * script evaluates and therefore sees every listener, timer and object URL the
 * app creates, including the ones created during boot.
 *
 * What it records:
 *
 *   - `paint` and `longtask` performance entries, `buffered: true` so the ones
 *     that fired before the observer existed are still delivered.
 *   - Two moments, polled once per real frame: the first frame the app has
 *     rendered anything into `#root`, and the first frame the primary call to
 *     action is genuinely hittable (laid out, fully opaque, and the topmost
 *     element at its own centre). Frame-polled, so both carry ±1 frame of
 *     granularity by construction.
 *   - Live counts of event listeners, intervals, timeouts, object URLs,
 *     observers and WebSockets, by wrapping the constructors. These are the
 *     leak counters.
 *
 * ## What the wrappers can and cannot see
 *
 * `addEventListener`/`removeEventListener` are counted as a net: added minus
 * removed. A listener on a node that is simply dropped and garbage collected is
 * never "removed", so the net can climb without anything leaking. That is why
 * the authoritative listener number in the report comes from CDP
 * `Performance.getMetrics().JSEventListeners`, which is the engine's own count
 * of live listeners after a forced collection; the net here is the cross-check
 * that says whether the app is *detaching* what it attaches.
 *
 * Timers and object URLs have no CDP equivalent, so those counters are the only
 * source and they are exact: a timeout is decremented when it fires or is
 * cleared, an interval when it is cleared, an object URL when it is revoked.
 */

/**
 * Runs inside the page before anything else. Must be self-contained —
 * Playwright serialises it to source.
 *
 * @param {{ ctaText: string | null }} options `null` on a screen with no call
 *   to action (the workspace fixtures): the per-frame search for it is then
 *   never started, because on a thread of 1,000 messages that search is itself
 *   a measurable cost.
 */
export function installProbes({ ctaText }) {
  const state = {
    ctaText,
    /** @type {{ start: number, duration: number }[]} */
    longTasks: [],
    /**
     * Event Timing entries for key and pointer input, 16ms and over (the API's
     * floor): from the event to the next paint, the browser's own number.
     * @type {{ name: string, start: number, duration: number, processing: number }[]}
     */
    inputEvents: [],
    /**
     * Every keydown, to the first animation frame after it, in ms. The Event
     * Timing API cannot report under 16ms, so this is the whole distribution
     * and those entries are the cross-check on the tail.
     * @type {number[]}
     */
    keyToFrame: [],
    /** @type {Record<string, number>} */
    paint: {},
    /** @type {Record<string, number|null>} */
    marks: { appFirstRender: null, ctaInteractive: null },
    live: {
      listeners: 0,
      intervals: 0,
      timeouts: 0,
      objectUrls: 0,
      observers: 0,
      sockets: 0,
      mediaTracks: 0,
    },
    totals: {
      listenersAdded: 0,
      listenersRemoved: 0,
      intervalsSet: 0,
      intervalsCleared: 0,
      timeoutsSet: 0,
      objectUrlsCreated: 0,
      objectUrlsRevoked: 0,
      socketsOpened: 0,
      rafCallbacks: 0,
    },
  };
  Object.defineProperty(window, '__perf', { value: state, configurable: false });

  // ---------------------------------------------------------------- observers

  const observe = (type, handler, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(handler)).observe({
        type,
        buffered: true,
        ...extra,
      });
    } catch {
      // `longtask` is not implemented everywhere; a missing entry type must not
      // take the whole measurement down. The report says which ones arrived.
    }
  };

  observe('longtask', (entry) => {
    state.longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observe('paint', (entry) => {
    state.paint[entry.name] = entry.startTime;
  });
  observe('largest-contentful-paint', (entry) => {
    state.paint['largest-contentful-paint'] = entry.startTime;
  });
  observe(
    'event',
    (entry) => {
      if (!/^(key|pointer|click|input|beforeinput)/.test(entry.name)) return;
      state.inputEvents.push({
        name: entry.name,
        start: entry.startTime,
        duration: entry.duration,
        processing: entry.processingEnd - entry.processingStart,
      });
    },
    { durationThreshold: 16 },
  );

  // ------------------------------------------------------------------ wrappers

  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (...args) {
    state.live.listeners += 1;
    state.totals.listenersAdded += 1;
    return addListener.apply(this, args);
  };
  EventTarget.prototype.removeEventListener = function (...args) {
    state.live.listeners -= 1;
    state.totals.listenersRemoved += 1;
    return removeListener.apply(this, args);
  };

  const realSetInterval = window.setInterval;
  const realClearInterval = window.clearInterval;
  const liveIntervals = new Set();
  window.setInterval = function (...args) {
    const id = realSetInterval.apply(window, args);
    liveIntervals.add(id);
    state.live.intervals = liveIntervals.size;
    state.totals.intervalsSet += 1;
    return id;
  };
  window.clearInterval = function (id) {
    if (liveIntervals.delete(id)) state.totals.intervalsCleared += 1;
    state.live.intervals = liveIntervals.size;
    return realClearInterval.call(window, id);
  };

  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const liveTimeouts = new Set();
  window.setTimeout = function (handler, ...rest) {
    // Wrapping the callback is what makes this count *pending* timeouts rather
    // than every timeout ever scheduled: a fired timeout is no longer live.
    let id;
    const wrapped =
      typeof handler === 'function'
        ? function (...callbackArgs) {
            liveTimeouts.delete(id);
            state.live.timeouts = liveTimeouts.size;
            return handler.apply(this, callbackArgs);
          }
        : handler;
    id = realSetTimeout.call(window, wrapped, ...rest);
    liveTimeouts.add(id);
    state.live.timeouts = liveTimeouts.size;
    state.totals.timeoutsSet += 1;
    return id;
  };
  window.clearTimeout = function (id) {
    liveTimeouts.delete(id);
    state.live.timeouts = liveTimeouts.size;
    return realClearTimeout.call(window, id);
  };

  if (window.URL?.createObjectURL) {
    const realCreate = window.URL.createObjectURL;
    const realRevoke = window.URL.revokeObjectURL;
    const liveUrls = new Set();
    window.URL.createObjectURL = function (object) {
      const url = realCreate.call(window.URL, object);
      liveUrls.add(url);
      state.live.objectUrls = liveUrls.size;
      state.totals.objectUrlsCreated += 1;
      return url;
    };
    window.URL.revokeObjectURL = function (url) {
      if (liveUrls.delete(url)) state.totals.objectUrlsRevoked += 1;
      state.live.objectUrls = liveUrls.size;
      return realRevoke.call(window.URL, url);
    };
  }

  for (const name of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver']) {
    const Real = window[name];
    if (!Real) continue;
    class Counted extends Real {
      disconnect() {
        if (!this.__perfDisconnected) {
          this.__perfDisconnected = true;
          state.live.observers -= 1;
        }
        return super.disconnect();
      }
    }
    Object.defineProperty(Counted, 'name', { value: name });
    window[name] = new Proxy(Counted, {
      construct(target, args, newTarget) {
        state.live.observers += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  if (window.WebSocket) {
    const RealSocket = window.WebSocket;
    window.WebSocket = new Proxy(RealSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        state.live.sockets += 1;
        state.totals.socketsOpened += 1;
        const drop = () => {
          if (socket.__perfCounted) return;
          socket.__perfCounted = true;
          state.live.sockets -= 1;
        };
        addListener.call(socket, 'close', drop);
        addListener.call(socket, 'error', drop);
        // The two listeners above are the harness's own; undo their effect on
        // the net so a socket does not look like two leaked listeners.
        state.live.listeners -= 2;
        state.totals.listenersAdded -= 2;
        return socket;
      },
    });
  }

  if (navigator.mediaDevices?.getUserMedia) {
    // Never fires on the signed-out surface — nothing there asks for a
    // microphone — but the counter is what the call flow will need on the day
    // this harness can reach it, and an instrument that is added afterwards is
    // an instrument that was not watching when the leak was introduced.
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await realGetUserMedia(...args);
      for (const track of stream.getTracks()) {
        state.live.mediaTracks += 1;
        const drop = () => {
          if (track.__perfCounted) return;
          track.__perfCounted = true;
          state.live.mediaTracks -= 1;
        };
        addListener.call(track, 'ended', drop);
        // The harness's own listener, undone in the net so a track does not
        // read as a leaked listener.
        state.live.listeners -= 1;
        state.totals.listenersAdded -= 1;
        const realStop = track.stop.bind(track);
        track.stop = () => {
          drop();
          return realStop();
        };
      }
      return stream;
    };
  }

  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    state.totals.rafCallbacks += 1;
    return realRaf(callback);
  };

  // Keydown to the next frame. Captured on the window before anything in the
  // app sees the event; the frame callback runs once the handlers — and the
  // synchronous render a discrete event triggers — have finished. Attached
  // with the unwrapped `addEventListener`, so it is not in the leak counters.
  addListener.call(
    window,
    'keydown',
    () => {
      const at = performance.now();
      realRaf(() => state.keyToFrame.push(performance.now() - at));
    },
    { capture: true },
  );

  // --------------------------------------------------------------- the moments

  /** Opacity of `el` including every ancestor's, and 0 if anything hides it. */
  const effectiveOpacity = (el) => {
    let opacity = 1;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return 0;
      opacity *= Number.parseFloat(style.opacity || '1');
    }
    return opacity;
  };

  /**
   * The call to action is "interactive" when it is laid out, effectively
   * opaque, and the topmost element at its own centre.
   *
   * All three matter. `elementFromPoint` alone is satisfied while the button is
   * still at opacity 0 — it is in the hit-test tree from the first frame — so
   * hit-testing alone would report a time ~1s earlier than a person could
   * plausibly act. Opacity alone would accept a button under an overlay.
   */
  const findInteractiveCta = () => {
    const candidates = [...document.querySelectorAll('[role="button"], button, a')];
    for (const el of candidates) {
      if (el.textContent?.trim() !== state.ctaText) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (effectiveOpacity(el) < 0.99) continue;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit && (hit === el || el.contains(hit))) return el;
    }
    return null;
  };

  const poll = () => {
    if (state.marks.appFirstRender === null) {
      const root = document.getElementById('root');
      if (root && root.childElementCount > 0) state.marks.appFirstRender = performance.now();
    }
    if (state.ctaText !== null && state.marks.ctaInteractive === null && findInteractiveCta()) {
      state.marks.ctaInteractive = performance.now();
    }
    const waiting =
      state.marks.appFirstRender === null ||
      (state.ctaText !== null && state.marks.ctaInteractive === null);
    if (waiting) realRaf(poll);
  };
  realRaf(poll);

  /** Frames actually painted over `ms`, i.e. is this screen still animating. */
  state.countFrames = (ms) =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        const now = performance.now();
        if (now - start >= ms) {
          resolve({ frames, elapsed: now - start });
          return;
        }
        frames += 1;
        realRaf(tick);
      };
      realRaf(tick);
    });

  /**
   * A client-side route change, timed from inside the page.
   *
   * `pushState` + `popstate` is the router's own web transport — React
   * Navigation's linking subscribes to `popstate` — so this is a real route
   * change and not a synthetic re-render: the whole subtree of the old route
   * unmounts and the new one mounts.
   *
   * The arrival signal is text on the destination screen, polled once per
   * frame. `innerText` forces a layout on each poll, which adds a little to the
   * number; the alternative, a MutationObserver, fires on the first DOM write
   * rather than on the first frame a person could see, which would report a
   * time that is too good. The figure is therefore "until the destination is on
   * screen", measured the pessimistic way, and it is the same pessimism every
   * cycle.
   *
   * @param {string} to
   * @param {string} needle
   * @param {number} timeoutMs
   */
  state.routeTo = (to, needle, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const start = performance.now();
      history.pushState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      const check = () => {
        if (document.body.innerText.includes(needle)) {
          resolve(performance.now() - start);
          return;
        }
        if (performance.now() - start > timeoutMs) {
          reject(new Error(`route to ${to} never showed ${JSON.stringify(needle)}`));
          return;
        }
        realRaf(check);
      };
      realRaf(check);
    });

  /** Everything worth reading out of the page in one round trip. */
  state.snapshot = () => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const script = resources.filter((r) => r.initiatorType === 'script');
    return {
      marks: { ...state.marks },
      paint: { ...state.paint },
      navigation: navigation
        ? {
            responseStart: navigation.responseStart,
            domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
            loadEventEnd: navigation.loadEventEnd,
            domInteractive: navigation.domInteractive,
          }
        : null,
      longTasks: state.longTasks.slice(),
      live: { ...state.live },
      totals: { ...state.totals },
      scripts: {
        count: script.length,
        transferBytes: script.reduce((sum, r) => sum + (r.transferSize || 0), 0),
        decodedBytes: script.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
      },
      // `performance.memory` is Chromium-only and quantised; the report prefers
      // the CDP heap figure and carries this one only as a cross-check.
      jsHeapFromPage: window.performance.memory?.usedJSHeapSize ?? null,
    };
  };
}
