/**
 * What `codea login` shows while it waits, and the one thing it will launch.
 *
 * ## What this replaces
 *
 * `commands/auth.ts` used to print the raw approval code under "Approve this
 * sign-in in the Oxy app, or at oxy.so", then hand the `oxycommons://` deep link
 * to `xdg-open` unconditionally and swallow the result. On WSL2 and over SSH
 * that launcher either does not exist or exits into a void — so exactly the
 * machines that most needed a way forward got a code, a domain that is not an
 * approval page, and a blank wait.
 *
 * Now three affordances are always printed, and none of them depends on a
 * launcher working:
 *
 *  - a QR of the deep link, for the Commons app on a phone to scan;
 *  - the https link to `auth.oxy.so/device`, the same consent page an MCP
 *    connector or an app sign-in shows, for a person approving in a browser;
 *  - the code itself, which that page repeats so the person can check the two
 *    match.
 *
 * Opening the link is something the person asks for (Enter), never something
 * that happens to them.
 */

import { execFile } from 'node:child_process';
import chalk from 'chalk';
import QRCode from 'qrcode';

const DEFAULT_AUTH_ORIGIN = 'https://auth.oxy.so';

/**
 * The approval page's query parameter — deliberately NOT `code`.
 *
 * `auth.oxy.so` runs `OxyProvider`, whose cold boot reads any `?code=` on page
 * load as the return leg of an OAuth redirect and strips it from the address
 * bar before the page can read it. `user_code` is the name RFC 8628 gives the
 * code a device shows a person to approve, which is what this is.
 */
const CODE_PARAM = 'user_code';

/**
 * The https approval link for a PUBLIC authorize code.
 *
 * Built with `URL` rather than interpolation: the code is server-supplied, and
 * `searchParams` encodes it, so a malformed value cannot graft extra parameters
 * onto a URL that is about to be handed to the operating system. The secret
 * `sessionToken` has no business here and is not accepted.
 *
 * `OXY_AUTH_URL` points it at a local `packages/auth` for development — the same
 * variable the Oxy API reads for the same host.
 */
export function approvalUrl(
  authorizeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = new URL('/device', env.OXY_AUTH_URL || DEFAULT_AUTH_ORIGIN);
  url.searchParams.set(CODE_PARAM, authorizeCode);
  return url.href;
}

// ── QR ──────────────────────────────────────────────────────────────────────

/**
 * Light modules around the symbol, in modules. Four is what the QR
 * specification asks for; less is the classic reason a phone will not lock on.
 */
const QUIET_ZONE = 4;

/** Columns every QR line is indented by, so the symbol does not touch the edge. */
export const QR_INDENT = '  ';

/** Explicit white background + black foreground: scans the same on light and dark themes. */
const QR_LINE_START = '\x1b[47m\x1b[30m';
const QR_LINE_END = '\x1b[0m';

/** Highest density first; the lower level is the fallback for a narrower terminal. */
const QR_LEVELS = ['M', 'L'] as const;

export interface QrMatrix {
  readonly size: number;
  isDark(x: number, y: number): boolean;
}

/**
 * Draw a symbol with half-block characters, two modules per terminal row.
 *
 * Drawn here rather than through `qrcode`'s own terminal renderer because that
 * one leaves a single-module border and ends an odd row with a half cell on the
 * terminal's OWN background — a dark stripe inside the quiet zone on a dark
 * theme. Every cell below sits on an explicit white background, so the quiet
 * zone is light all the way round.
 */
export function drawQr(matrix: QrMatrix): string[] {
  const dark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < matrix.size && y < matrix.size && matrix.isDark(x, y);

  const lines: string[] = [];
  for (let y = -QUIET_ZONE; y < matrix.size + QUIET_ZONE; y += 2) {
    let row = '';
    for (let x = -QUIET_ZONE; x < matrix.size + QUIET_ZONE; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      row += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' ';
    }
    lines.push(QR_LINE_START + row + QR_LINE_END);
  }
  return lines;
}

function matrixFor(payload: string, level: (typeof QR_LEVELS)[number]): QrMatrix {
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: level });
  return { size: modules.size, isDark: (x, y) => Boolean(modules.get(y, x)) };
}

/** Terminal columns a symbol of `size` modules needs, indent included. */
function columnsNeeded(size: number): number {
  return QR_INDENT.length + size + 2 * QUIET_ZONE;
}

/**
 * The QR for `payload`, or `null` when no level fits in `columns`.
 *
 * The payload is encoded VERBATIM: Commons' parser matches the literal
 * `oxycommons://approve` prefix, so any normalising here is a QR that scans and
 * then does nothing.
 */
export function renderQr(payload: string, columns: number): string[] | null {
  for (const level of QR_LEVELS) {
    const matrix = matrixFor(payload, level);
    if (columnsNeeded(matrix.size) <= columns) return drawQr(matrix);
  }
  return null;
}

/** The narrowest terminal that still gets a QR for `payload`. */
export function minimumQrColumns(payload: string): number {
  return columnsNeeded(matrixFor(payload, QR_LEVELS[QR_LEVELS.length - 1]).size);
}

// ── The printed block ───────────────────────────────────────────────────────

export interface ApprovalSurfaceInput {
  readonly authorizeCode: string;
  readonly qrPayload: string;
  readonly approvalUrl: string;
  /** `process.stdout.columns`; `undefined` when stdout is not a terminal. */
  readonly columns: number | undefined;
  /** stdout is a terminal. A QR in a pipe or a CI log is unscannable noise. */
  readonly canRenderQr: boolean;
  /** stdin AND stdout are terminals, so a keypress can be asked for and seen. */
  readonly canPromptEnter: boolean;
}

/**
 * Everything printed before the wait, as lines.
 *
 * `renderer` is injectable so a test can assert the exact payload that is
 * encoded without reading pixels back out of the terminal output.
 */
export function approvalLines(
  input: ApprovalSurfaceInput,
  renderer: (payload: string, columns: number) => string[] | null = renderQr,
): string[] {
  const lines: string[] = [];

  if (input.canRenderQr) {
    const qr = renderer(input.qrPayload, input.columns ?? 80);
    lines.push(chalk.gray('Scan this QR with the Commons app to approve:'), '');
    if (qr) {
      lines.push(...qr.map((line) => QR_INDENT + line));
    } else {
      lines.push(
        chalk.gray(
          `${QR_INDENT}(Terminal too narrow for the QR — widen it to ${minimumQrColumns(input.qrPayload)} columns, or use the link below.)`,
        ),
      );
    }
    lines.push('', chalk.gray('Or approve in your browser:'));
  } else {
    lines.push(chalk.gray('Approve in your browser:'));
  }

  lines.push(
    '',
    '    ' + chalk.cyan.underline(input.approvalUrl),
    '',
    chalk.gray('Your code (the page shows the same one):'),
    '',
    '    ' + chalk.bold.cyan(input.authorizeCode),
    '',
    chalk.blue('ℹ ') +
      (input.canPromptEnter
        ? 'Waiting for approval — press Enter to open the link in your browser.'
        : 'Waiting for approval...'),
  );
  return lines;
}

// ── Opening the link ────────────────────────────────────────────────────────

export interface LaunchTarget {
  readonly command: string;
  readonly args: readonly string[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Only `https:` is handed to the operating system — plus plain `http:` to a
 * loopback host, which is what `OXY_AUTH_URL` names during development.
 * Anything else (`file:`, `javascript:`, a custom scheme the OS would treat as
 * an instruction) is left for the person to read, never launched.
 */
function isLaunchable(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Which program would open `url` here, or `null` if it must not be launched.
 *
 * Always a program plus an argv ARRAY, run through `execFile`, never a shell
 * string: the code inside the URL came off the network, and a shell would read
 * its metacharacters as syntax.
 *
 * WSL is its own row because it is the case that failed silently: `xdg-open`
 * exists there but has no Linux browser to hand the page to, while
 * `explorer.exe` opens the Windows default browser.
 */
export function launchTargetFor(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): LaunchTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isLaunchable(parsed)) return null;

  const href = parsed.href;
  if (platform === 'darwin') return { command: 'open', args: [href] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', href] };
  if (platform === 'linux' && env.WSL_DISTRO_NAME) {
    return { command: 'explorer.exe', args: [href] };
  }
  return { command: 'xdg-open', args: [href] };
}

type Launcher = (
  command: string,
  args: string[],
  callback: (error: { readonly code?: unknown } | null) => void,
) => unknown;

/**
 * Best-effort: the link is already on screen, so a launch that fails costs the
 * person nothing but a keypress.
 *
 * Only a MISSING launcher is reported. A non-zero exit is not: `explorer.exe`
 * exits 1 even after it has opened the page.
 */
export function openInBrowser(
  url: string,
  onProblem: (message: string) => void,
  launch: Launcher = (command, args, callback) =>
    execFile(command, args, (error) => callback(error)),
): void {
  const target = launchTargetFor(url);
  if (!target) {
    onProblem('This link cannot be opened automatically. Open it by hand.');
    return;
  }
  launch(target.command, [...target.args], (error) => {
    if (error?.code === 'ENOENT') {
      onProblem(`No browser launcher found (${target.command}). Open the link above by hand.`);
    }
  });
}

/**
 * Call `onEnter` once when the person presses Enter.
 *
 * Cooked mode, no `setRawMode` and no `readline`: the terminal driver keeps
 * owning Ctrl+C, Enter arrives as a line, and there is no terminal state to
 * restore afterwards. With stdin not a terminal (a pipe, CI) there is nothing to
 * wait for, and the disposer is a no-op.
 *
 * The disposer must run — in a `finally` — however the wait ends. It detaches
 * AND pauses: a resumed stdin keeps the event loop alive, so `codea login` would
 * never exit, and `codea chat` would hand Ink a stream someone else is reading.
 */
export function watchForEnter(
  onEnter: () => void,
  stdin: NodeJS.ReadStream = process.stdin,
): () => void {
  if (!stdin.isTTY) return () => {};

  let active = true;
  const dispose = (): void => {
    if (!active) return;
    active = false;
    stdin.off('data', onData);
    stdin.pause();
  };
  function onData(chunk: Buffer | string): void {
    const text = String(chunk);
    if (!text.includes('\n') && !text.includes('\r')) return;
    dispose();
    onEnter();
  }

  stdin.on('data', onData);
  stdin.resume();
  return dispose;
}

// ── Time ────────────────────────────────────────────────────────────────────

/**
 * An expiry as epoch milliseconds, whatever it arrived as.
 *
 * `@oxy.so/core` types a device sign-in's `expiresAt` as a number, but the API
 * sends an ISO-8601 string and core passes it through — so a `Date.now() >=
 * expiresAt` check compares against `NaN` and is never true.
 */
export function toEpochMs(value: unknown, fallbackMs: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

/** "4m 30s", "45s", or "0s" — never `NaN`. */
export function remainingTime(expiresAtMs: number, now: number = Date.now()): string {
  const remaining = expiresAtMs - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return '0s';
  const seconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
