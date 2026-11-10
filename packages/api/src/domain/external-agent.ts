/**
 * Closed value sets and wire protocol for external agents (ADR 0028).
 *
 * A leaf module: the drizzle schema renders its CHECK from {@link EXTERNAL_AGENT_CLIS}, and the
 * daemon (`@alia-codea/cli`) mirrors the frame shapes below by hand, so keep them boring.
 */

/** The coding-agent CLIs a daemon can drive. */
export const EXTERNAL_AGENT_CLIS = ['claude', 'codex', 'opencode'] as const;
export type ExternalAgentCli = (typeof EXTERNAL_AGENT_CLIS)[number];

/** How long a pairing code can be redeemed. */
export const EXTERNAL_PAIRING_TTL_MS = 10 * 60 * 1000;

/** Pairing codes are `XXXX-XXXX` over an alphabet without look-alikes (no 0/O, 1/I/L). */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_GROUPS = 3;
export const PAIRING_CODE_GROUP_LENGTH = 4;

/** An external agent that does not answer within this long has failed its turn. */
export const EXTERNAL_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** Frames the server sends to the daemon. */
export type ServerFrame =
  | { type: 'auth-ok'; agentId: string }
  | { type: 'auth-error'; reason: string }
  | {
      type: 'turn';
      turnId: string;
      /** What to answer: the latest message, framed for the agent. */
      task: string;
      history: readonly { role: 'user' | 'assistant'; content: string }[];
    }
  | { type: 'cancel'; turnId: string }
  | { type: 'revoked' };

/** Frames the daemon sends to the server. */
export type DaemonFrame =
  | { type: 'auth'; token: string; agentId: string }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'end'; turnId: string; text?: string }
  | { type: 'error'; turnId: string; message: string };

export function isExternalAgentCli(value: unknown): value is ExternalAgentCli {
  return typeof value === 'string' && (EXTERNAL_AGENT_CLIS as readonly string[]).includes(value);
}
