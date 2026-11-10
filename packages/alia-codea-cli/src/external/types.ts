/**
 * The daemon's side of the external-agent protocol (ADR 0028). Mirrors
 * `packages/api/src/domain/external-agent.ts`; the two are kept boring on purpose.
 */

export const EXTERNAL_CLIS = ['claude', 'codex', 'opencode'] as const;
export type ExternalCli = (typeof EXTERNAL_CLIS)[number];

export function isExternalCli(value: unknown): value is ExternalCli {
  return typeof value === 'string' && (EXTERNAL_CLIS as readonly string[]).includes(value);
}

export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type ServerFrame =
  | { type: 'auth-ok'; agentId: string }
  | { type: 'auth-error'; reason: string }
  | { type: 'turn'; turnId: string; task: string; history: readonly ChatTurn[] }
  | { type: 'cancel'; turnId: string }
  | { type: 'revoked' };

export type DaemonFrame =
  | { type: 'auth'; token: string; agentId: string }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'end'; turnId: string; text?: string }
  | { type: 'error'; turnId: string; message: string };

export interface RuntimeRun {
  /** The full prompt: framing, history and the new message. */
  readonly prompt: string;
  readonly cwd: string;
  /** Let the agent edit files in `cwd`. Off by default: read-only. */
  readonly write: boolean;
  readonly signal: AbortSignal;
  readonly onDelta: (text: string) => void;
}

/** One coding-agent CLI, driven non-interactively under the person's own login. */
export interface ExternalRuntime {
  readonly cli: ExternalCli;
  /** Resolves with the agent's full answer. Rejects with a message fit to show the person. */
  run(input: RuntimeRun): Promise<string>;
}
