/**
 * The browser worker's process: one headless Chromium, a context per actor,
 * the API in `worker-server.ts`. Runs in the browser container the control API
 * creates (`browser-stack.ts`) under gVisor, on an internal network whose only
 * way out is the egress proxy.
 *
 *   ALIA_BROWSER_TOKEN          the control API's bearer for this container's life
 *   ALIA_BROWSER_PROXY          http://<egress proxy IP>:3128
 *   ALIA_BROWSER_PROFILES       where each actor's storage state lives (a volume)
 *   ALIA_BROWSER_MAX_CONTEXTS   default 3
 *   ALIA_BROWSER_IDLE_MS        a context with no call for this long is closed
 *   PLAYWRIGHT_BROWSERS_PATH    where the image installed Chromium
 */
import { chromium } from 'playwright-core';
import { BrowserPool } from './pool.js';
import { createWorkerServer } from './worker-server.js';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
};

const token = env('ALIA_BROWSER_TOKEN');
const proxy = new URL(env('ALIA_BROWSER_PROXY'));
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ msg, ...fields }));

const pool = new BrowserPool({
  profilesDir: env('ALIA_BROWSER_PROFILES', '/profiles'),
  downloadsDir: '/tmp/alia-downloads',
  maxContexts: Number(env('ALIA_BROWSER_MAX_CONTEXTS', '3')),
  idleMs: Number(env('ALIA_BROWSER_IDLE_MS', String(10 * 60_000))),
  ownerControlMs: 15 * 60_000,
  log,
  launch: () =>
    chromium.launch({
      headless: true,
      // Playwright already runs Chromium without its own sandbox in a
      // container; the boundary is gVisor plus this container's flags.
      chromiumSandbox: false,
      // Chromium does not need the worker's token in its environment.
      env: { HOME: '/tmp', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      proxy: { server: proxy.origin, bypass: '<-loopback>' },
      timeout: 30_000,
      args: [
        // Every byte through the proxy: no QUIC (UDP), no WebRTC UDP that is
        // not proxied, and no name resolution of its own.
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.hostname}`,
        '--proxy-bypass-list=<-loopback>',
        // Memory and quiet: this container is capped at 1 GiB.
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--no-first-run',
        '--no-default-browser-check',
        '--js-flags=--max-old-space-size=256',
      ],
    }),
});

const server = createWorkerServer({ pool, token });
server.listen(Number(process.env.PORT || 8790), '0.0.0.0', () => log('browser worker listening'));

const sweeper = setInterval(() => {
  pool.sweep().then(
    (closed) => {
      if (closed > 0) log('idle browser contexts closed', { closed });
    },
    () => log('browser sweep failed'),
  );
}, 30_000);
sweeper.unref();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(sweeper);
  const deadline = setTimeout(() => process.exit(1), 9_000);
  deadline.unref();
  // Every context's storage state is saved on the way out, so a login made
  // just before the host went to sleep survives it.
  server.close();
  void pool.shutdown().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
