/**
 * What a turn knows about the person and the actor before it is answered:
 * memory, Oxy profile, entitlements, the agent, skills and recalled memories.
 *
 * Extracted from `buildChatRequestContext` (ADR 0017 §3) so that a typed turn
 * and a voice call read the SAME inputs from an identity, and voice never
 * drifts from chat. The chat handler still owns everything that is about the
 * HTTP request — body validation, credit reservation, the refusals it writes;
 * this module owns only the reads, and takes an identity instead of `req`.
 *
 * The module paths below are the ones `request-context.ts` imported inline,
 * so the suites that mock those seams keep intercepting them.
 */

import { getDb } from '../../db/index.js';
import { findAgentSkills } from '../../db/agents/agentRepository.js';
import { findUserMemory, type UserMemoryProfile } from '../../db/memory/userMemoryRepository.js';
import { oxyClient } from '../../middleware/auth.js';
import { loadTurnAgent } from '../agent-account.js';
import type { HydratedAgent } from '../agent-identity.js';
import { runBeforeChatHooks } from '../hooks/index.js';
import { log } from '../logger.js';
import type { ChatMessage } from '../message-converter.js';
import { getUserEntitlements, type Entitlements } from '../plan-access.js';
import { buildSkillRuntime, type SkillRuntime } from '../skills/runtime.js';
import type { OxyUserProfile } from '../system-prompt-builder.js';

/** Who the turn is for. */
export interface TurnIdentity {
  /** The authenticated person, or `undefined` for an anonymous caller. */
  readonly oxyUserId: string | undefined;
  readonly accessToken?: string;
  /** A person's own session (not a service acting for them). */
  readonly isDirectUserSession: boolean;
  /** An exact agent selector the caller already validated, or `undefined` for Alia. */
  readonly requestedAgentId?: string;
  /** The app the turn comes from, by its verified app assertion (`lib/app-surface.ts`), or `null`. */
  readonly surfaceApplicationId: string | null;
}

/** What `loadTurnAgent` answered, plus the two failures this module adds. */
export type TurnAgentResolution =
  | Awaited<ReturnType<typeof loadTurnAgent>>
  | { readonly kind: 'none' }
  | { readonly kind: 'resolution_unavailable' };

export interface PrefetchedTurnInputs {
  readonly userMemory: UserMemoryProfile | null;
  readonly oxyUser: OxyUserProfile | null;
  readonly entitlements: Entitlements | null;
  readonly turnAgent: TurnAgentResolution;
}

/** The skill runtime of a turn that has none. */
export const EMPTY_SKILL_RUNTIME: SkillRuntime = {
  index: '',
  active: '',
  tools: {},
  agentScoped: false,
  candidateIds: [],
  activated: () => [],
};

/**
 * The independent reads, in parallel. Each fails soft except the agent: an
 * explicit agent selector that cannot be resolved is `resolution_unavailable`,
 * never `none` — a turn that named an agent is never answered by somebody else.
 */
export async function prefetchTurnInputs(identity: TurnIdentity): Promise<PrefetchedTurnInputs> {
  const { oxyUserId, isDirectUserSession, requestedAgentId } = identity;
  const [userMemory, oxyUser, entitlements, turnAgent] = await Promise.all([
    oxyUserId !== undefined
      ? findUserMemory(getDb(), oxyUserId)
          .then((memory) => memory ?? null)
          .catch(() => null)
      : Promise.resolve(null),

    // The profile is an HTTP call to Oxy: bounded, so a slow Oxy never holds a turn.
    isDirectUserSession && oxyUserId !== undefined
      ? Promise.race<OxyUserProfile | null>([
          oxyClient.users.get(oxyUserId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]).catch(() => null)
      : Promise.resolve<OxyUserProfile | null>(null),

    oxyUserId !== undefined
      ? getUserEntitlements(oxyUserId).catch(() => null)
      : Promise.resolve(null),

    requestedAgentId !== undefined && oxyUserId !== undefined
      ? loadTurnAgent(getDb(), {
          agentId: requestedAgentId,
          oxyUserId,
          accessToken: identity.accessToken,
          surfaceApplicationId: identity.surfaceApplicationId,
        }).catch((err: unknown): TurnAgentResolution => {
          log.v1.warn({ err, agentId: requestedAgentId }, 'Could not resolve the turn agent');
          return { kind: 'resolution_unavailable' };
        })
      : Promise.resolve<TurnAgentResolution>({ kind: 'none' }),
  ]);
  return { userMemory, oxyUser, entitlements, turnAgent };
}

/**
 * The skills this turn may reach, after the agent is known: an agent reaches
 * the skills linked to it, Alia the person's installed ones. `null` when the
 * runtime cannot be built (the turn goes on without skills).
 */
export async function buildTurnSkills(input: {
  readonly oxyUserId: string;
  readonly linkedAgent: HydratedAgent | null;
  readonly selectedSkillNames?: string[] | null;
}): Promise<SkillRuntime | null> {
  const { oxyUserId, linkedAgent } = input;
  try {
    return await buildSkillRuntime({
      db: getDb(),
      oxyUserId,
      selectedNames: input.selectedSkillNames,
      agentSkillIds: linkedAgent
        ? (await findAgentSkills(getDb(), linkedAgent.id)).map((ref) => ref._id)
        : [],
      includeUserInstalled: linkedAgent === null,
    });
  } catch (err) {
    // The agent-skill lookup is inside the guard too: a fault there is a turn
    // without skills, not a turn that throws after credits were reserved.
    log.v1.warn({ err }, 'Skill runtime unavailable for this turn');
    return null;
  }
}

/** Memories recalled for this turn by the before-chat hooks, if any. */
export async function recallTurnMemories(input: {
  readonly oxyUserId: string;
  readonly conversationId: string | undefined;
  readonly messages: ChatMessage[];
  readonly modelId: string;
  readonly selectedSkillNames?: string[] | null;
}): Promise<Array<{ title: string; summary: string }> | undefined> {
  const hookResult = await runBeforeChatHooks({
    userId: input.oxyUserId,
    conversationId: input.conversationId,
    messages: input.messages,
    model: input.modelId,
    skillNames: input.selectedSkillNames ?? undefined,
    platform: 'app' as const,
    metadata: {},
  }).catch(() => null);
  return hookResult?.metadata?.recalledMemories as
    | Array<{ title: string; summary: string }>
    | undefined;
}
