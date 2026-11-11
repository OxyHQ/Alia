/**
 * Turn admission, the two gates `buildChatRequestContext` runs before it
 * reserves credits: the requester's rolling usage window, and the agent's
 * feature gates (power levels, attachments, deep research) with the reading of
 * the turn's files. Both are called from `request-context.ts`.
 */
import { USAGE_WINDOW_CREDITS, readUsageWindow, type UsageWindow } from '../usage-window.js';
import { getUserEntitlements } from '../plan-access.js';
import { log } from '../logger.js';
import type { FilePartRef } from '../message-converter.js';
import { FilePartError, resolveFileParts, type ResolvedFiles } from '../files/person-files.js';
import {
  gatesAnyPowerLevel,
  checkGatedParts,
  gatedPartsFor,
  spendGatedParts,
  type FeatureRefusal,
  type GatedPart,
} from '../agent-features.js';
import type { TurnAgentResolution } from './turn-inputs.js';

/**
 * The requester's rolling usage window, or `null` when their plan has none or
 * it cannot be read — the window fails open.
 */
export async function usageWindowFor(
  oxyUserId: string,
  productPlanId: string | null = null,
): Promise<UsageWindow | null> {
  try {
    const entitlements = await getUserEntitlements(oxyUserId);
    const legacyPlanId = entitlements?.planId;
    const selected =
      productPlanId &&
      (USAGE_WINDOW_CREDITS.get(productPlanId) ?? 0) >
        (USAGE_WINDOW_CREDITS.get(legacyPlanId ?? 'free') ?? Infinity)
        ? productPlanId
        : legacyPlanId;
    return selected ? await readUsageWindow(oxyUserId, selected) : null;
  } catch (error) {
    log.v1.warn(
      { err: error },
      'Usage window unavailable; the turn goes ahead on the balance alone',
    );
    return null;
  }
}

/** What admitting a turn's gated uses came to. */
export type FeatureAdmission =
  | { readonly ok: true; readonly files: ResolvedFiles }
  | {
      readonly ok: false;
      readonly status: number;
      readonly refusal: {
        readonly message: string;
        readonly type: 'invalid_request_error' | 'server_error';
        readonly param: 'messages' | 'model' | 'deepResearch';
        readonly code: string;
        readonly retryable: boolean;
        readonly feature?: string;
      };
    };

function featureRefusal(refusal: FeatureRefusal): FeatureAdmission {
  const entitlement = refusal.code === 'feature_entitlement_required';
  const what = refusal.feature.startsWith('attachments.')
    ? 'this attachment'
    : refusal.feature === 'deep_research'
      ? 'deep research'
      : `the ${refusal.feature.slice('power_level.'.length)} level`;
  return {
    ok: false,
    status: entitlement ? 403 : 503,
    refusal: {
      message: entitlement
        ? `This agent needs an upgrade in its app for ${what}.`
        : `The app that unlocks ${what} could not be asked. Please try again.`,
      type: entitlement ? 'invalid_request_error' : 'server_error',
      param: refusal.feature.startsWith('power_level.')
        ? 'model'
        : refusal.feature === 'deep_research'
          ? 'deepResearch'
          : 'messages',
      code: refusal.code,
      feature: refusal.feature,
      retryable: refusal.retryable,
    },
  };
}

/**
 * Check the agent's gates for what this turn uses, read every document, then
 * spend each gated use — in that order, so a locked feature downloads nothing
 * and an unreadable document spends nothing. Called before the credit
 * reservation, which it gates.
 *
 * An agent that gates a power level refuses a hosted model named EXACTLY
 * (`power_level_required`): Alia does not know an exact model's level (that is
 * Oxy's reviewed catalogue data), so a `pro` gate an exact `publisher/model`
 * could reach around would be no gate. A level is what a person chooses in the
 * product (ADR 0014); the exact-model lane is for pinned agents and background
 * calls, which never pass through here. A model on the person's own device
 * (`local/…`) is not Alia's inference and is not gated.
 */
export async function admitTurnFeatures(input: {
  /** The turn's agent, when the request names one. */
  turnAgent: Promise<TurnAgentResolution> | null;
  uses: readonly GatedPart[];
  fileRefs: ReadonlyMap<string, FilePartRef>;
  exactHostedModel: boolean;
  person: {
    accountId: string | undefined;
    accessToken: string | undefined;
    taskId?: string;
    runId: string;
  };
  modelAcceptsFiles: boolean;
}): Promise<FeatureAdmission> {
  const resolution = input.turnAgent === null ? null : await input.turnAgent;
  // An agent that did not resolve is refused after admission; it gates nothing.
  const agent = resolution?.kind === 'agent' ? resolution.agent : null;
  if (agent !== null && input.exactHostedModel && gatesAnyPowerLevel(agent)) {
    return {
      ok: false,
      status: 400,
      refusal: {
        message: "This agent's power levels are unlocked through its app; choose a power level.",
        type: 'invalid_request_error',
        param: 'model',
        code: 'power_level_required',
        retryable: false,
      },
    };
  }
  const gated = agent === null ? [] : gatedPartsFor(agent, input.uses);
  const person =
    input.person.accountId === undefined
      ? null
      : {
          accountId: input.person.accountId,
          accessToken: input.person.accessToken,
          taskId: input.person.taskId,
          runId: input.person.runId,
        };

  if (agent !== null && gated.length > 0) {
    if (person === null) {
      return featureRefusal({
        code: 'feature_entitlement_required',
        feature: gated[0].feature,
        retryable: false,
      });
    }
    const locked = await checkGatedParts(agent, person, gated);
    if (locked !== null) return featureRefusal(locked);
  }

  let files: ResolvedFiles;
  try {
    files = await resolveFileParts(input.fileRefs, {
      personAccountId: input.person.accountId,
      accessToken: input.person.accessToken,
      taskId: input.person.taskId,
      modelAcceptsFiles: input.modelAcceptsFiles,
    });
  } catch (error: unknown) {
    if (!(error instanceof FilePartError)) throw error;
    return {
      ok: false,
      status: 400,
      refusal: {
        message: error.message,
        type: 'invalid_request_error',
        param: 'messages',
        code: error.code,
        retryable: false,
      },
    };
  }

  if (agent !== null && person !== null && gated.length > 0) {
    const refused = await spendGatedParts(agent, person, gated);
    if (refused !== null) return featureRefusal(refused);
  }
  return { ok: true, files };
}
