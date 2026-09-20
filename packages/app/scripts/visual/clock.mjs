/**
 * The virtual clock that makes an animated screen screenshottable.
 *
 * `AmbientField` runs three `withRepeat(..., -1)` float loops of 8s, 11s and
 * 9.5s plus a 900ms pulse. They never settle, so "wait a bit, then shoot" is
 * not a baseline — it is a lottery over the loop phase. Reanimated 4 on web
 * steps every animation from the timestamp its `requestAnimationFrame`
 * callback is handed (`valueSetter.js`: `step(timestamp)`) and reads
 * `performance.now()` for an animation's start time
 * (`react-native-worklets`: `_getAnimationTimestamp`). Owning those two numbers
 * owns the whole animation clock.
 *
 * What this installs, before any bundle script runs:
 *
 *   - `requestAnimationFrame` still fires on the browser's real frames, so the
 *     app keeps making progress, but every callback is handed
 *     `__visualClock.now` instead of the real elapsed time.
 *   - `now` starts at 0 and STAYS there through boot. That is the important
 *     half: every animation's start time is 0 no matter how many real frames
 *     the machine spent booting the bundle, so a fast machine and a slow one
 *     start from the same instant.
 *   - `performance.now()` and `Date.now()` read the same virtual clock, so
 *     nothing can sample a second, real clock behind our backs.
 *   - `playTo(ms)` then advances `now` by exactly one 60fps frame per real
 *     frame until it reaches `ms`, and stops dead there.
 *
 * ## Why a replay and not a jump
 *
 * Setting `now = 6000` in one step does not work, and the failure is quiet
 * rather than loud. `withDelay(400, withTiming(...))` is a delay animation that
 * starts the inner tween on the first frame past the delay — so a single jump
 * satisfies the delay at t=6000 and starts a 500ms tween AT 6000, against a
 * clock that never moves again. The subtitle and the call to action sit at
 * opacity 0 forever and the screenshot looks like a screen that renders a
 * headline and nothing else. Measured: a one-jump capture at 6000ms lost the
 * subtitle, both buttons and the body reveal.
 *
 * Replaying at a fixed virtual step gives every chained animation the
 * intermediate timestamps it needs, and the step is a constant rather than
 * whatever the machine managed, so the result is identical on a fast host and a
 * slow one.
 *
 * Deliberately NOT pinned: `Math.random` and `crypto.randomUUID`. Seeding them
 * would make React keys and query keys collide, which changes what renders — a
 * worse trade than the nothing they contribute to this screen's pixels.
 */

/** The virtual frame duration. A replay is therefore an exact 60fps playback. */
export const VIRTUAL_FRAME_MS = 1000 / 60;

/**
 * Runs inside the page, before anything else. Must be self-contained: Playwright
 * serialises it to source.
 *
 * @param {{ epoch: number, frameMs: number }} options
 */
export function installVirtualClock({ epoch, frameMs }) {
  const state = { now: 0, frames: 0, epoch, frameMs };
  Object.defineProperty(window, '__visualClock', { value: state, configurable: false });

  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    realRaf(() => {
      state.frames += 1;
      callback(state.now);
    });

  // `cancelAnimationFrame` is left alone on purpose: the wrapper returns the
  // real handle, so cancelling by that handle still works.

  window.performance.now = () => state.now;

  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      // Only "what time is it now" is pinned; every explicit construction is
      // left exactly as the caller wrote it.
      if (args.length === 0) super(state.epoch + state.now);
      else super(...args);
    }
    static now() {
      return state.epoch + state.now;
    }
  }
  window.Date = VirtualDate;

  /** Advance one virtual frame per real frame, then stop. */
  state.playTo = (target) =>
    new Promise((resolve) => {
      const tick = () => {
        if (state.now >= target) {
          resolve();
          return;
        }
        state.now = Math.min(target, state.now + state.frameMs);
        realRaf(tick);
      };
      realRaf(tick);
    });

  /**
   * Wait `count` real frames with the clock held still.
   *
   * Driven off the unwrapped `requestAnimationFrame` rather than the page's own
   * frame counter, because under `prefers-reduced-motion` Reanimated finishes
   * every animation instantly and stops asking for frames at all — a settle
   * that waited on the app's frames would wait forever.
   */
  state.settle = (count) =>
    new Promise((resolve) => {
      let seen = 0;
      const tick = () => {
        seen += 1;
        if (seen >= count) resolve();
        else realRaf(tick);
      };
      realRaf(tick);
    });
}

/**
 * Replays the page up to an exact virtual millisecond and leaves it frozen
 * there, settled.
 *
 * @param {import('playwright-core').Page} page
 * @param {number} ms
 */
export async function playTo(page, ms) {
  await page.evaluate((target) => window.__visualClock.playTo(target), ms);
  // The value setter and the style mapper are separate frames, so the last
  // animated value needs a couple of motionless frames to reach the DOM. Ten is
  // generous and costs a sixth of a second.
  await page.evaluate(() => window.__visualClock.settle(10));
}
