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
 * rule: session handling lives entirely in `@oxy.so/core`, and every one of those
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
 *
 * ## How the code reaches an approver
 *
 * Printing the code and firing the `oxycommons://` deep link at `xdg-open` was
 * not enough: the only thing that could resolve that code was the Commons app,
 * and on WSL or over SSH the launcher failed silently. The waiting screen now
 * comes from `utils/approval-surface.ts` — a QR for Commons, the link to
 * `auth.oxy.so/device` for a browser, and the code — and the browser opens only
 * when the person presses Enter.
 */

import chalk from 'chalk';

import {
  approvalLines,
  approvalUrl,
  openInBrowser,
  remainingTime,
  watchForEnter,
} from '../utils/approval-surface.js';
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

/**
 * How often "still waiting" is repeated. The poll ticks every two seconds; a
 * line per tick would bury the link and the code under a five-minute wait.
 */
const WAITING_NOTICE_INTERVAL_MS = 30_000;

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

  const url = approvalUrl(handle.authorizeCode);
  const canPromptEnter = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  for (const line of approvalLines({
    authorizeCode: handle.authorizeCode,
    qrPayload: handle.qrPayload,
    approvalUrl: url,
    columns: process.stdout.columns,
    canRenderQr: Boolean(process.stdout.isTTY),
    canPromptEnter,
  })) {
    console.log(line);
  }

  // The keypress and the poll race; neither owns the other. Approving through
  // the QR ends the wait with the listener still attached, which is why it is
  // released in `finally` rather than on the Enter path.
  const stopWatching = canPromptEnter
    ? watchForEnter(() => {
        console.log(chalk.gray('  Opening your browser...'));
        openInBrowser(url, (problem) => console.log(chalk.gray(`  ${problem}`)));
      })
    : () => {};

  let lastNotice = Date.now();
  try {
    const outcome = await waitForApproval(handle, {
      onWaiting: () => {
        const now = Date.now();
        if (now - lastNotice < WAITING_NOTICE_INTERVAL_MS) return;
        lastNotice = now;
        console.log(
          chalk.gray(`  Still waiting — this code expires in ${remainingTime(handle.expiresAt, now)}.`),
        );
      },
    });
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
  } finally {
    stopWatching();
  }
}

export async function logout(): Promise<void> {
  await signOut();
  printSuccess('Logged out successfully.');
}
