/**
 * `codea login` / `codea logout`, on Oxy's device flow.
 *
 * ## What was deleted, and why none of it was ported
 *
 * This file used to hold a complete authorization flow of its own: a PKCE
 * verifier and challenge generated with `node:crypto`, a loopback `http` server
 * listening on an ephemeral port to catch a redirect, a browser launch, a
 * five-minute timer, and an exchange against `POST /auth/token` on
 * `api.alia.onl` that minted an `alia_sk_*` developer credential. Plus a manual
 * "paste your API key" fallback.
 *
 * #160 closed that endpoint — it answers `410 Gone` — so the flow does not work
 * any more. But the reason it is deleted rather than repointed is the ecosystem
 * rule: session handling lives entirely in `@oxyhq/core`, and every one of those
 * pieces is the platform-agnostic half core already owns and does better
 * (single-flight re-mint, rotation, durability checks, a bounded cold boot).
 *
 * The device flow needs none of it. There is no port to listen on, no redirect
 * to catch, and no secret in the URL: the CLI asks Oxy for a single-use code,
 * prints it, and polls. That works over SSH, in a container, and on a machine
 * with no browser — none of which the loopback flow did.
 *
 * The API-key fallback is gone too, and deliberately: Alia issues no new
 * `alia_sk_*` credential, so a prompt inviting someone to paste one is a prompt
 * for a credential they can no longer obtain.
 */

import chalk from 'chalk';
import { execFile } from 'node:child_process';

import {
  disposeSession,
  restoreSession,
  signOut,
  startSignIn,
  waitForApproval,
} from '../utils/oxy-session.js';

function printSuccess(message: string): void {
  console.log(chalk.green('✓ ') + message);
}

function printError(message: string): void {
  console.log(chalk.red('✗ Error: ') + message);
}

function printInfo(message: string): void {
  console.log(chalk.blue('ℹ ') + message);
}

/**
 * Schemes this is willing to hand to the operating system.
 *
 * `qrPayload` is documented as an `oxycommons://approve?...` deep link, and `https`
 * is accepted for the browser-resolvable form of the same approval.
 */
const LAUNCHABLE_SCHEMES = new Set(['oxycommons:', 'https:']);

/**
 * Best-effort convenience only.
 *
 * The code is printed either way, because this is exactly the flow that has to
 * keep working on a machine with no desktop — over SSH, in CI, inside a
 * container. A launcher that fails silently must not be able to strand the user.
 *
 * ## Two guards, because this value comes off the network
 *
 * `qrPayload` is SERVER-supplied. Interpolating it into a shell string would
 * make a compromised or spoofed Oxy response into arbitrary command execution on
 * the user's machine — the previous implementation built exactly such a string,
 * though from a locally-constructed URL rather than a remote one.
 *
 *  1. `execFile`, never `exec`: no shell is involved, so shell metacharacters in
 *     the argument are passed through to the program as data.
 *  2. The scheme is checked against {@link LAUNCHABLE_SCHEMES} first, so a
 *     payload naming `file:` — or anything else the OS handler would treat as an
 *     instruction — is printed rather than launched.
 */
function openApprover(payload: string): void {
  let parsed: URL;
  try {
    parsed = new URL(payload);
  } catch {
    return;
  }
  if (!LAUNCHABLE_SCHEMES.has(parsed.protocol)) return;

  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [parsed.href]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', parsed.href]]
        : ['xdg-open', [parsed.href]];

  execFile(command, args, () => {
    // Ignored on purpose: the printed code above is the real affordance, and a
    // machine with no launcher must still be able to complete this flow.
  });
}

export async function login(): Promise<boolean> {
  console.log();
  console.log(chalk.bold('Codea CLI Login'));
  console.log();

  // Already signed in? Say so rather than minting a second device session.
  if (await restoreSession()) {
    printSuccess('Already signed in.');
    disposeSession();
    return true;
  }

  let handle;
  try {
    handle = await startSignIn();
  } catch (error: unknown) {
    printError(
      `Could not reach Oxy to start sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  console.log(chalk.gray('Approve this sign-in in the Oxy app, or at oxy.so:'));
  console.log();
  console.log('    ' + chalk.bold.cyan(handle.authorizeCode));
  console.log();
  openApprover(handle.qrPayload);
  printInfo('Waiting for approval...');

  try {
    const outcome = await waitForApproval(handle);
    switch (outcome.kind) {
      case 'signed-in':
        console.log();
        printSuccess('Logged in successfully!');
        console.log(chalk.gray(`Welcome, ${outcome.username}!`));
        disposeSession();
        return true;
      case 'cancelled':
        printError('The sign-in was declined.');
        return false;
      case 'expired':
      case 'timed-out':
        printError('The sign-in code expired. Run `codea login` again.');
        return false;
    }
  } catch (error: unknown) {
    printError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function logout(): Promise<void> {
  await signOut();
  printSuccess('Logged out successfully.');
}
