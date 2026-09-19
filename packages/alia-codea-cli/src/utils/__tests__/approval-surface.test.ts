import { PassThrough } from 'node:stream';
import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import {
  approvalLines,
  approvalUrl,
  drawQr,
  launchTargetFor,
  minimumQrColumns,
  openInBrowser,
  remainingTime,
  renderQr,
  toEpochMs,
  watchForEnter,
  type ApprovalSurfaceInput,
} from '../approval-surface.js';

/**
 * The waiting screen of `codea login`.
 *
 * The payloads are the real shape `POST /auth/session/create` mints
 * (`packages/api/src/routes/auth.ts` in the Oxy repo), including the empty
 * `origin=` a CLI produces because it sends no `Origin`. The `app=` id comes in
 * the two shapes Oxy stores (`@oxy.so/db` `generatedId`): a 24-hex Mongo id for
 * applications registered before the Postgres cutover, a uuid v7 after. Length
 * is the point — it decides the QR version — so sizes below are derived from the
 * encoder rather than written down, and a short invented fixture would pass
 * width checks the real payload fails.
 *
 * The QR is never decoded by a scanner here. What IS proven is the two halves a
 * scan depends on: the payload handed to the encoder is the server's string,
 * byte for byte, and the drawing is a lossless picture of the encoder's modules.
 */

const CODE = '9354243fe1ebfeb4fc1a71e7348690c8';
const payloadFor = (appId: string) =>
  `oxycommons://approve?v=1&code=${CODE}&app=${appId}&origin=&nonce=0123456789abcdef&exp=1758000000000`;
const PAYLOADS = {
  legacyMongoId: payloadFor('65f1c2a9b8e4d7f0a1b2c3d4'),
  uuidV7: payloadFor('01920f3a-7b2c-7d4e-8f5a-6b7c8d9e0f1a'),
};
const PAYLOAD = PAYLOADS.uuidV7;

const QUIET = 4;
const sizeAt = (payload: string, level: 'M' | 'L') =>
  QRCode.create(payload, { errorCorrectionLevel: level }).modules.size;

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const width = (line: string) => [...stripAnsi(line)].length;

function input(overrides: Partial<ApprovalSurfaceInput> = {}): ApprovalSurfaceInput {
  return {
    authorizeCode: CODE,
    qrPayload: PAYLOAD,
    approvalUrl: approvalUrl(CODE, {}),
    columns: 100,
    canRenderQr: true,
    canPromptEnter: true,
    ...overrides,
  };
}

describe('approvalUrl', () => {
  it('points at the device consent page with the code under user_code, never code', () => {
    const url = new URL(approvalUrl(CODE, {}));
    expect(url.origin).toBe('https://auth.oxy.so');
    expect(url.pathname).toBe('/device');
    expect([...url.searchParams.keys()]).toEqual(['user_code']);
    expect(url.searchParams.get('user_code')).toBe(CODE);
  });

  it('encodes a hostile code instead of letting it add parameters', () => {
    const url = new URL(approvalUrl('abc&redirect=https://evil.example#x', {}));
    expect([...url.searchParams.keys()]).toEqual(['user_code']);
    expect(url.searchParams.get('user_code')).toBe('abc&redirect=https://evil.example#x');
    expect(url.hash).toBe('');
  });

  it('follows OXY_AUTH_URL for a local auth app, dropping any path it carries', () => {
    expect(approvalUrl(CODE, { OXY_AUTH_URL: 'http://localhost:5173/whatever' })).toBe(
      `http://localhost:5173/device?user_code=${CODE}`,
    );
  });
});

describe('QR', () => {
  it('draws exactly the modules the encoder produced, with a light quiet zone', () => {
    const symbol = QRCode.create(PAYLOAD, { errorCorrectionLevel: 'M' });
    const size = symbol.modules.size;
    const lines = drawQr({ size, isDark: (x, y) => Boolean(symbol.modules.get(y, x)) }).map(stripAnsi);

    // Read the picture back: each character is two vertically stacked modules.
    const quiet = QUIET;
    const span = size + 2 * quiet;
    const readBack = (x: number, y: number) => {
      const char = [...lines[Math.floor(y / 2)]][x];
      return y % 2 === 0 ? char === '█' || char === '▀' : char === '█' || char === '▄';
    };
    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        const inside = x >= quiet && y >= quiet && x < size + quiet && y < size + quiet;
        const expected = inside && Boolean(symbol.modules.get(y - quiet, x - quiet));
        expect(readBack(x, y)).toBe(expected);
      }
    }
  });

  it('puts every QR line on an explicit white background, so dark themes scan too', () => {
    const qr = renderQr(PAYLOAD, 100)!;
    for (const line of qr) expect(line.startsWith('\x1b[47m\x1b[30m')).toBe(true);
  });

  it.each(Object.entries(PAYLOADS))(
    'fits the terminal for a %s app: M when there is room, L when narrower, nothing below that',
    (_shape, payload) => {
      const needM = 2 + sizeAt(payload, 'M') + 2 * QUIET;
      const needL = 2 + sizeAt(payload, 'L') + 2 * QUIET;
      expect(needL).toBeLessThan(needM);
      // An ordinary 80-column terminal gets the denser symbol.
      expect(needM).toBeLessThanOrEqual(80);

      expect(Math.max(...renderQr(payload, needM)!.map(width))).toBe(needM - 2);
      expect(Math.max(...renderQr(payload, needM - 1)!.map(width))).toBe(needL - 2);
      expect(minimumQrColumns(payload)).toBe(needL);
      expect(renderQr(payload, needL - 1)).toBeNull();
    },
  );
});

describe('approvalLines', () => {
  it('hands the renderer the server payload verbatim', () => {
    const renderer = vi.fn(() => ['QR']);
    approvalLines(input(), renderer);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(renderer.mock.calls[0]).toEqual([PAYLOAD, 100]);
  });

  it('shows the QR, the link and the code, and offers Enter, on an interactive terminal', () => {
    const text = approvalLines(input()).map(stripAnsi).join('\n');
    expect(text).toContain('Commons');
    expect(text).toContain(`https://auth.oxy.so/device?user_code=${CODE}`);
    expect(text).toContain(CODE);
    expect(text).toMatch(/press Enter/);
    // Every visible line fits the terminal it was drawn for.
    for (const line of approvalLines(input())) expect(width(line)).toBeLessThanOrEqual(100);
  });

  it('prints no QR and asks for no keypress when output is not a terminal', () => {
    const renderer = vi.fn(() => ['QR']);
    const lines = approvalLines(input({ columns: undefined, canRenderQr: false, canPromptEnter: false }), renderer);
    const joined = lines.join('\n');
    expect(renderer).not.toHaveBeenCalled();
    expect(joined).not.toContain('\x1b[47m');
    expect(joined).not.toMatch(/Enter/);
    expect(stripAnsi(joined)).toContain(`https://auth.oxy.so/device?user_code=${CODE}`);
    expect(stripAnsi(joined)).toContain(CODE);
  });

  it('explains a missing QR on a narrow terminal and still gives the link and code', () => {
    const text = approvalLines(input({ columns: 40 })).map(stripAnsi).join('\n');
    expect(text).toContain(`too narrow for the QR — widen it to ${minimumQrColumns(PAYLOAD)} columns`);
    expect(text).toContain(`user_code=${CODE}`);
    expect(text).toContain(CODE);
  });

  it('never prints the secret session token, because it is never given one', () => {
    const text = approvalLines(input()).map(stripAnsi).join('\n');
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('launchTargetFor', () => {
  const url = approvalUrl(CODE, {});

  it('refuses anything but https, and http to loopback', () => {
    expect(launchTargetFor('file:///etc/passwd', 'linux', {})).toBeNull();
    expect(launchTargetFor('javascript:alert(1)', 'darwin', {})).toBeNull();
    expect(launchTargetFor('oxycommons://approve?code=x', 'darwin', {})).toBeNull();
    expect(launchTargetFor('http://evil.example/device', 'linux', {})).toBeNull();
    expect(launchTargetFor('not a url', 'linux', {})).toBeNull();
    expect(launchTargetFor('http://localhost:5173/device', 'linux', {})).not.toBeNull();
  });

  it('picks the launcher per platform, with WSL handed to the Windows browser', () => {
    expect(launchTargetFor(url, 'darwin', {})).toEqual({ command: 'open', args: [url] });
    expect(launchTargetFor(url, 'win32', {})).toEqual({ command: 'cmd', args: ['/c', 'start', '', url] });
    expect(launchTargetFor(url, 'linux', { WSL_DISTRO_NAME: 'Debian' })).toEqual({
      command: 'explorer.exe',
      args: [url],
    });
    expect(launchTargetFor(url, 'linux', {})).toEqual({ command: 'xdg-open', args: [url] });
  });

  it('always passes the URL as its own argument, never inside a command string', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const target = launchTargetFor(url, platform, {})!;
      expect(target.command).not.toContain(url);
      expect(target.args.at(-1)).toBe(url);
    }
  });
});

describe('openInBrowser', () => {
  const url = approvalUrl(CODE, {});

  it('reports a missing launcher, and stays quiet about a non-zero exit', () => {
    const problems: string[] = [];
    openInBrowser(url, (p) => problems.push(p), (_c, _a, cb) => cb({ code: 1 }));
    expect(problems).toEqual([]);
    openInBrowser(url, (p) => problems.push(p), (_c, _a, cb) => cb({ code: 'ENOENT' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/No browser launcher found/);
  });

  it('launches nothing for a URL it refuses', () => {
    const launch = vi.fn();
    const problems: string[] = [];
    openInBrowser('file:///etc/passwd', (p) => problems.push(p), launch);
    expect(launch).not.toHaveBeenCalled();
    expect(problems).toHaveLength(1);
  });
});

describe('watchForEnter', () => {
  function tty(isTTY: boolean) {
    const stream = new PassThrough() as PassThrough & { isTTY: boolean };
    stream.isTTY = isTTY;
    return stream as unknown as NodeJS.ReadStream & PassThrough;
  }

  it('does nothing at all when stdin is not a terminal', () => {
    const stdin = tty(false);
    const onEnter = vi.fn();
    const dispose = watchForEnter(onEnter, stdin);
    stdin.write('\n');
    expect(onEnter).not.toHaveBeenCalled();
    expect(stdin.listenerCount('data')).toBe(0);
    dispose();
  });

  it('fires once on Enter, ignores other input, and releases stdin', async () => {
    const stdin = tty(true);
    const onEnter = vi.fn();
    const dispose = watchForEnter(onEnter, stdin);

    stdin.write('abc');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onEnter).not.toHaveBeenCalled();

    stdin.write('\n');
    stdin.write('\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.isPaused()).toBe(true);
    dispose(); // idempotent
  });

  it('releases stdin when disposed without Enter — the QR approval path', () => {
    const stdin = tty(true);
    const dispose = watchForEnter(vi.fn(), stdin);
    expect(stdin.listenerCount('data')).toBe(1);
    dispose();
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.isPaused()).toBe(true);
  });
});

describe('time', () => {
  it('reads an expiry the API sends as an ISO string', () => {
    expect(toEpochMs(1_758_000_000_000, 0)).toBe(1_758_000_000_000);
    expect(toEpochMs('2026-09-16T12:00:00.000Z', 0)).toBe(Date.parse('2026-09-16T12:00:00.000Z'));
    expect(toEpochMs('nonsense', 42)).toBe(42);
    expect(toEpochMs(undefined, 42)).toBe(42);
    expect(toEpochMs(Number.NaN, 42)).toBe(42);
  });

  it('formats what is left without ever printing NaN', () => {
    expect(remainingTime(210_000, 0)).toBe('3m 30s');
    expect(remainingTime(45_900, 0)).toBe('45s');
    expect(remainingTime(-5, 0)).toBe('0s');
    expect(remainingTime(Number.NaN, 0)).toBe('0s');
  });
});
