import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { getOxyActor } from '@oxy.so/core/server';
import { appSurfaceOf } from '../app-surface';
import { getDb } from '../../db';
import {
  turnControlRepository,
  TurnControlError,
  type TurnControlRepository,
  type TurnIdentity,
} from '../../db/chat/turnControlRepository';
import { CHAT_TURN_CHECK_TIMEOUT_MS, CHAT_TURN_POLL_MS } from '../../domain/chat-turn-control';
import { checkWindowLimit } from '../sliding-window-limiter';

export { TurnControlError };

export async function turnIdentity(req: Request, id: unknown): Promise<TurnIdentity> {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new TypeError('turnId must be a UUID v4');
  }
  const conversationId = req.body?.conversationId ?? null;
  if (
    conversationId !== null &&
    (typeof conversationId !== 'string' || !conversationId || conversationId.length > 128)
  ) {
    throw new TypeError('Invalid conversationId');
  }
  let tuple: (string | null)[];
  if (req.machineCredential) {
    const p = req.machineCredential;
    tuple = ['machine', p.applicationId, p.credentialId, p.environment];
  } else {
    const actor = getOxyActor(req);
    // A channel or delegated service's billing owner is NOT the human requester.
    if (req.serviceApp || req.channelContext || !req.sessionId || !actor || !req.user?.id) {
      throw new TurnControlError('turn_control_unsupported');
    }
    tuple = ['session', actor.actorAccountId, req.user.id, await appSurfaceOf(req)];
  }
  return {
    id: id.toLowerCase(),
    conversationId,
    authorityKey: createHash('sha256').update(JSON.stringify(tuple)).digest('hex'),
  };
}

export function answerTurnControlError(res: Response, error: unknown): void {
  const code =
    error instanceof TurnControlError
      ? error.code
      : error instanceof TypeError
        ? 'invalid_turn'
        : 'turn_control_unavailable';
  const status =
    code === 'invalid_turn'
      ? 400
      : code === 'turn_not_found'
        ? 404
        : code === 'turn_control_unavailable'
          ? 503
          : code === 'turn_control_unsupported'
            ? 403
            : 409;
  res.status(status).json({ error: { code, message: code, type: 'invalid_request_error' } });
}

export async function cancelChatTurn(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const identity = await turnIdentity(req, req.params.turnId);
    const limit = await checkWindowLimit(`rl:turn-control:${identity.authorityKey}`, 60);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.resetInSeconds ?? 60));
      res.status(429).json({ error: { code: 'RATE_LIMIT_EXCEEDED' } });
      return;
    }
    const state = await turnControlRepository(getDb()).cancel(identity);
    res.status(200).json({ turnId: identity.id, state });
  } catch (error) {
    answerTurnControlError(res, error);
  }
}

/** One batched observer per process, with Postgres as its only authority. */
export class ChatTurnObserver {
  private readonly active = new Map<string, { owner: string; controller: AbortController }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking = false;
  constructor(private readonly repository: TurnControlRepository) {}

  private schedule() {
    if (!this.timer && !this.checking && this.active.size) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.check();
      }, CHAT_TURN_POLL_MS);
    }
  }

  private async check() {
    this.checking = true;
    const snapshot = new Map(this.active);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const rows = await Promise.race([
        this.repository.readActive([...snapshot.keys()]),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new TurnControlError('turn_control_unavailable')),
            CHAT_TURN_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const [id, entry] of snapshot) {
        if (this.active.get(id) !== entry) continue;
        const row = byId.get(id);
        if (row?.state === 'running' && row.owner === entry.owner) continue;
        this.active.delete(id);
        entry.controller.abort(
          new TurnControlError(
            row?.state === 'cancelled' ? 'turn_cancelled' : 'turn_control_unavailable',
          ),
        );
      }
    } catch (error) {
      for (const [id, entry] of snapshot) {
        if (this.active.get(id) !== entry) continue;
        this.active.delete(id);
        entry.controller.abort(error);
      }
    } finally {
      clearTimeout(deadline);
      this.checking = false;
      this.schedule();
    }
  }

  observe(identity: TurnIdentity, owner: string, controller: AbortController) {
    const entry = { owner, controller };
    this.active.set(identity.id, entry);
    this.schedule();
    const stop = () => {
      if (this.active.get(identity.id) === entry) this.active.delete(identity.id);
      if (!this.active.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
    return {
      beginFinish: async () => {
        controller.signal.throwIfAborted();
        // The DB CAS resolves a concurrent Stop, not the observer's cached view.
        stop();
        try {
          await this.repository.beginFinish(identity, owner);
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      },
      stop,
    };
  }
}

let shared: { repository: TurnControlRepository; observer: ChatTurnObserver } | undefined;
export function chatTurnControl() {
  if (!shared) {
    const repository = turnControlRepository(getDb());
    shared = { repository, observer: new ChatTurnObserver(repository) };
  }
  return shared;
}
