/**
 * Awaited host tools: the answer route and the wait (`docs/agent-embedding.md` §2).
 *
 * The client answers an awaited `alia.host_action` on `POST /v1/chat/turns/:turnId/host-results`,
 * authenticated and authority-bound exactly as Stop is (`turn-control.ts`). The answer may land on
 * any replica, so it is written to PostgreSQL; the replica whose turn waits reads every answer its
 * process is waiting for in one batch every 250 ms, as `ChatTurnObserver` does for Stop.
 *
 * What the client sends is the person's own content (a page's text). It is held only until the
 * waiting turn reads it, never logged (sizes only), and goes to the model like any tool result.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  hostResultRepository,
  HostResultError,
  type HostResultAnswer,
  type HostResultKey,
  type HostResultRepository,
} from '../../db/chat/hostResultRepository';
import {
  HOST_RESULT_DETAIL_MAX_CHARS,
  HOST_RESULT_MAX_CHARS,
  HOST_RESULT_WAIT_MS,
  HOST_TOOL_OUTCOMES,
} from '../../domain/chat-host-results';
import { CHAT_TURN_CHECK_TIMEOUT_MS, CHAT_TURN_POLL_MS } from '../../domain/chat-turn-control';
import { log } from '../logger';
import { checkWindowLimit } from '../sliding-window-limiter';
import { answerTurnControlError, turnIdentity } from './turn-control';

const hostResultBodySchema = z
  .object({
    toolCallId: z.string().min(1).max(128),
    outcome: z.enum(HOST_TOOL_OUTCOMES),
    detail: z.string().max(HOST_RESULT_DETAIL_MAX_CHARS).optional(),
    result: z.unknown().optional(),
  })
  .strict();

class HostResultBodyError extends Error {
  constructor(
    public readonly code: 'invalid_host_result' | 'host_result_too_large',
    public readonly param: string,
    message: string,
  ) {
    super(message);
  }
}

/** The characters `result` takes as JSON, or `null` when it is not a JSON value. */
function serializedLength(result: unknown): number | null {
  try {
    const text = JSON.stringify(result);
    return typeof text === 'string' ? text.length : null;
  } catch {
    return null;
  }
}

export function parseHostResultBody(body: unknown): {
  toolCallId: string;
  answer: HostResultAnswer;
} {
  const parsed = hostResultBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const param = issue?.path.join('.') || 'body';
    throw new HostResultBodyError(
      'invalid_host_result',
      param,
      `Invalid host result: ${issue ? `${param}: ${issue.message}` : 'malformed'}`,
    );
  }
  const { toolCallId, outcome, detail, result } = parsed.data;
  const present = result !== undefined && result !== null;
  if (present) {
    const length = serializedLength(result);
    if (length === null) {
      throw new HostResultBodyError('invalid_host_result', 'result', 'result must be JSON');
    }
    if (length > HOST_RESULT_MAX_CHARS) {
      throw new HostResultBodyError(
        'host_result_too_large',
        'result',
        `result is ${length} characters as JSON; at most ${HOST_RESULT_MAX_CHARS} are accepted`,
      );
    }
  }
  return {
    toolCallId,
    answer: {
      outcome,
      ...(detail === undefined || detail === '' ? {} : { detail }),
      ...(present ? { result } : {}),
    },
  };
}

function answerHostResultError(res: Response, error: unknown): void {
  if (error instanceof HostResultBodyError) {
    res.status(400).json({
      error: {
        code: error.code,
        message: error.message,
        param: error.param,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  if (error instanceof HostResultError) {
    res.status(error.code === 'host_result_not_found' ? 404 : 409).json({
      error: { code: error.code, message: error.code, type: 'invalid_request_error' },
    });
    return;
  }
  answerTurnControlError(res, error);
}

/** `POST /v1/chat/turns/:turnId/host-results` */
export async function submitHostResult(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { toolCallId, answer } = parseHostResultBody(req.body);
    const identity = await turnIdentity(req, req.params.turnId);
    const limit = await checkWindowLimit(`rl:turn-host-results:${identity.authorityKey}`, 60);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.resetInSeconds ?? 60));
      res.status(429).json({ error: { code: 'RATE_LIMIT_EXCEEDED' } });
      return;
    }
    await hostResultRepository(getDb()).answer(
      { turnId: identity.id, toolCallId, authorityKey: identity.authorityKey },
      answer,
    );
    log.v1.info(
      {
        turnId: identity.id,
        outcome: answer.outcome,
        resultChars: answer.result === undefined ? 0 : serializedLength(answer.result),
      },
      'Host result received',
    );
    res.status(200).json({ turnId: identity.id, toolCallId, state: 'answered' });
  } catch (error) {
    answerHostResultError(res, error);
  }
}

const keyOf = (key: Pick<HostResultKey, 'turnId' | 'toolCallId'>) =>
  `${key.turnId}\u0000${key.toolCallId}`;

/** One batched reader per process, with PostgreSQL as its only store. */
export class HostResultWaiter {
  private readonly waiting = new Map<
    string,
    { key: HostResultKey; resolve: (answer: HostResultAnswer) => void }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking = false;

  constructor(
    private readonly repository: HostResultRepository,
    private readonly pollMs = CHAT_TURN_POLL_MS,
  ) {}

  private schedule() {
    if (!this.timer && !this.checking && this.waiting.size) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.check();
      }, this.pollMs);
    }
  }

  private async check() {
    this.checking = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const keys = [...this.waiting.values()].map((entry) => entry.key);
      const rows = await Promise.race([
        this.repository.take(keys),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Host result check timed out')),
            CHAT_TURN_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      for (const row of rows) this.waiting.get(keyOf(row))?.resolve(row.answer);
    } catch (err) {
      // The deadline of each wait still bounds it; a failed read is retried on the next tick.
      log.v1.warn({ err, waiting: this.waiting.size }, 'Host result check failed');
    } finally {
      clearTimeout(deadline);
      this.checking = false;
      this.schedule();
    }
  }

  /** Record that `key` is awaited. Call before the action reaches the client. */
  open(key: HostResultKey): Promise<void> {
    return this.repository.open(key);
  }

  /**
   * The client's answer, or `null` when none came before `timeoutMs` or `signal` ended the turn.
   * The row is gone either way when this settles.
   */
  wait(
    key: HostResultKey,
    signal: AbortSignal | undefined,
    timeoutMs = HOST_RESULT_WAIT_MS,
  ): Promise<HostResultAnswer | null> {
    const id = keyOf(key);
    return new Promise<HostResultAnswer | null>((resolve) => {
      let settled = false;
      let closing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (answer: HostResultAnswer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.waiting.get(id)?.resolve === deliver) this.waiting.delete(id);
        if (!this.waiting.size) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        resolve(answer);
      };
      const deliver = (answer: HostResultAnswer) => finish(answer);
      const giveUp = (useLateAnswer: boolean) => {
        if (settled || closing) return;
        closing = true;
        // A wedged store must not hold the tool: the close gets the control check's own deadline.
        clearTimeout(timer);
        timer = setTimeout(() => finish(null), CHAT_TURN_CHECK_TIMEOUT_MS);
        // Still registered while the row is closed: an answer a poll takes meanwhile is delivered.
        void this.repository
          .close(key)
          .then((late) => finish(useLateAnswer ? late : null))
          .catch((err: unknown) => {
            log.v1.warn({ err, turnId: key.turnId }, 'Host result row not closed');
            finish(null);
          });
      };
      const onAbort = () => giveUp(false);
      if (signal?.aborted) {
        giveUp(false);
        return;
      }
      this.waiting.set(id, { key, resolve: deliver });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => giveUp(true), timeoutMs);
      this.schedule();
    });
  }
}

let shared: HostResultWaiter | undefined;
export function hostResultWaiter(): HostResultWaiter {
  shared ??= new HostResultWaiter(hostResultRepository(getDb()));
  return shared;
}
