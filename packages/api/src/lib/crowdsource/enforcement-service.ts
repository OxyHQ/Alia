import type { Decision } from '@oxyhq/crowdsource-contracts';
import {
  findAgentModerationState,
  setAgentCatalogueFlags,
} from '../../db/agents/agentRepository.js';
import {
  findAgentReviewById,
  recalculateAgentRating,
  setAgentReviewHidden,
} from '../../db/agents/agentReviewRepository.js';
import { getDb } from '../../db/index.js';
import {
  findSkillPublication,
  setSkillPublication,
} from '../../db/agents/skillRepository.js';
import { ReportedType } from '../../domain/report.js';
import {
  claimEnforcement,
  findLastAppliedEnforcement,
  recordEnforcementApplied,
  recordEnforcementSkipped,
  releaseEnforcementClaim,
  type ModerationPreviousState,
} from '../../db/moderation/enforcementRepository.js';
import { type ModerationEnforcementAction } from '../../domain/moderation-enforcement.js';
import { crowdSourceConfig, type ModerationEnforcementMode } from './config.js';
import { planEnforcement, type PlannedEnforcementAction } from './enforcement-plan.js';
import { log } from '../logger.js';
import { recordMetric } from '../observability/index.js';

/**
 * Carrying out a decision, exactly once.
 *
 * Two guarantees, and everything here exists for one of them.
 *
 * **Once.** Appendix D's key is `decisionId + revision + action`, and the unique
 * index on `ModerationEnforcement` is that key. Each action CLAIMS its row before
 * doing anything; a second attempt — a redelivered webhook, a reclaimed outbox
 * lease, a manual replay — loses the insert and does nothing. Reading "have I done
 * this?" and then acting would leave the gap between the two, which is exactly
 * when a redelivery arrives.
 *
 * **Reversibly.** Every action that changes state records what the state WAS, and
 * a reversal puts that back. So a restore returns an agent to the publication
 * state it actually had rather than to a guess at one — a draft that was somehow
 * restricted must not be published by a correction.
 *
 * `observe` mode runs all of this except the effect. That is deliberate: the plan,
 * the claim and the record are identical to production, so what the mode proves is
 * exactly what will happen when it is switched off — and the audit trail is real
 * rather than a log line saying a decision was seen.
 */

export interface EnforcementSubject {
  /** Alia's own noun (`agent`, `agent_review`, `skill`). */
  type: string;
  id: string;
}

export interface EnforcementOutcome {
  action: ModerationEnforcementAction;
  /**
   * `applied` — the effect happened. `recorded` — claimed and deliberately not
   * carried out (observe/manual mode, or nothing to do). `duplicate` — another
   * delivery of this same decision revision already handled it.
   */
  result: 'applied' | 'recorded' | 'duplicate';
}

type EffectResult =
  | { changed: true; previousState: ModerationPreviousState }
  | { changed: false; reason: string };

/**
 * The most recent APPLIED action of a kind against this subject.
 *
 * A reversal reads the row that made the change rather than assuming a default,
 * which is what makes "restore" mean "put back what was there" instead of "set it
 * to whatever we think normal looks like".
 */
async function lastApplied(
  subject: EnforcementSubject,
  action: ModerationEnforcementAction,
): Promise<{ previousState: ModerationPreviousState | null } | null> {
  return await findLastAppliedEnforcement(subject.type, subject.id, action);
}

interface PublishableState {
  isPublished?: boolean;
  isFeatured?: boolean;
  isTrending?: boolean;
}

/**
 * `Agent` and `Skill` are read and written through explicit branches rather than
 * through one "catalog model" abstraction.
 *
 * A generic `Model<{ isPublished?: boolean }>` looks tidier and is how this was
 * first written, but reaching it needs a double cast through `unknown` — the two
 * document types genuinely are not assignable to a common one — and a cast there
 * would silently keep compiling if either dropped the field. Two branches of
 * three lines each cost nothing and stay honest with the schemas.
 *
 * ## `isValidObjectId` guards the AGENT branch only, and moving it was the point
 *
 * It used to guard both, at the top. `skills` is on Postgres now and its `id` is
 * `text`: a row created after the port carries a `generatedId()` uuid, which
 * `isValidObjectId` REJECTS. Leaving the guard where it was would have answered
 * "the reported object no longer exists" to every report about a skill made from
 * the port onwards — a permissive-direction failure that no test of today's rows
 * can see, because today's rows are all ObjectIds. `Agent` is still Mongoose and
 * still needs it, so the guard moved rather than went.
 */
async function loadPublishable(
  subject: EnforcementSubject,
): Promise<PublishableState | null> {
  if (subject.type === ReportedType.AGENT) {
    return await findAgentModerationState(getDb(), subject.id);
  }
  if (subject.type === ReportedType.SKILL) {
    return await findSkillPublication(getDb(), subject.id) ?? null;
  }
  return null;
}

/** Whether this subject type has a catalog row to publish or unpublish at all. */
function isPublishableType(subjectType: string): boolean {
  return subjectType === ReportedType.AGENT || subjectType === ReportedType.SKILL;
}

/**
 * `isFeatured` and `isTrending` reach the AGENT branch only.
 *
 * A skill has neither column — `demote` refuses a skill outright and `restore`
 * reads the demotion row only for an agent — so the skill branch takes the one
 * field it has. Asserting that rather than passing the whole patch through: a
 * `skills` table that grew an `is_featured` column would otherwise start
 * receiving moderation writes nobody decided to send it.
 */
async function updatePublishable(
  subject: EnforcementSubject,
  update: PublishableState,
): Promise<void> {
  if (subject.type === ReportedType.AGENT) {
    await setAgentCatalogueFlags(getDb(), subject.id, update);
    return;
  }
  if (update.isPublished !== undefined) {
    await setSkillPublication(getDb(), subject.id, update.isPublished);
  }
}

/** Take a published agent or skill out of the catalog. */
async function restrictPublishable(subject: EnforcementSubject): Promise<EffectResult> {
  if (!isPublishableType(subject.type)) {
    return { changed: false, reason: `Alia cannot restrict a ${subject.type}` };
  }
  const current = await loadPublishable(subject);
  if (!current) return { changed: false, reason: 'The reported object no longer exists' };
  if (current.isPublished !== true) {
    return { changed: false, reason: 'The object was already out of the catalog' };
  }
  await updatePublishable(subject, { isPublished: false });
  return { changed: true, previousState: { isPublished: true } };
}

/** Remove editorial promotion without unpublishing. Agents only. */
async function demote(subject: EnforcementSubject): Promise<EffectResult> {
  if (subject.type !== ReportedType.AGENT) {
    /**
     * A skill has no promotion flag — its `category` is chosen by its own author
     * through `POST /skills`, so changing it would be moderation editing somebody's
     * words rather than withdrawing Alia's endorsement. A review has none either.
     */
    return {
      changed: false,
      reason: `Alia has no editorial promotion to remove from a ${subject.type}`,
    };
  }
  const current = await loadPublishable(subject);
  if (!current) return { changed: false, reason: 'The reported agent no longer exists' };
  if (current.isFeatured !== true && current.isTrending !== true) {
    return { changed: false, reason: 'The agent carried no editorial promotion' };
  }
  await setAgentCatalogueFlags(getDb(), subject.id, { isFeatured: false, isTrending: false });
  return {
    changed: true,
    previousState: {
      isFeatured: current.isFeatured === true,
      isTrending: current.isTrending === true,
    },
  };
}

/** Withhold a review from the public listing and from the agent's rating. */
async function hideReview(subject: EnforcementSubject): Promise<EffectResult> {
  const review = await findAgentReviewById(getDb(), subject.id);
  if (!review) return { changed: false, reason: 'The reported review no longer exists' };
  if (review.hiddenByModeration) {
    return { changed: false, reason: 'The review was already withheld' };
  }
  await setAgentReviewHidden(getDb(), subject.id, true);
  // The rating is computed from visible reviews, so it has to move with them.
  await recalculateAgentRating(getDb(), review.agentId);
  return { changed: true, previousState: { hiddenByModeration: false } };
}

/** Put a withheld review back, only if MODERATION withheld it. */
async function unhideReview(subject: EnforcementSubject): Promise<EffectResult> {
  const review = await findAgentReviewById(getDb(), subject.id);
  if (!review) return { changed: false, reason: 'The reported review no longer exists' };
  if (!review.hiddenByModeration) {
    return { changed: false, reason: 'The review was not withheld' };
  }
  await setAgentReviewHidden(getDb(), subject.id, false);
  await recalculateAgentRating(getDb(), review.agentId);
  return { changed: true, previousState: { hiddenByModeration: true } };
}

/**
 * Undo everything moderation previously did to this subject.
 *
 * One action rather than a mirror of each effect, because that is what a
 * correction actually means: the case now says the material was fine, so every
 * consequence it caused comes off — the unpublish AND the demotion, in one row a
 * reader can point at.
 *
 * Each half is reversed from the row that made it, so an agent that was a draft
 * before it was restricted stays a draft, and an agent that was never featured is
 * not promoted by a restore into something it never was.
 */
async function restore(subject: EnforcementSubject): Promise<EffectResult> {
  if (subject.type === ReportedType.AGENT_REVIEW) return await unhideReview(subject);

  if (!isPublishableType(subject.type)) {
    return { changed: false, reason: `Alia cannot restore a ${subject.type}` };
  }
  const current = await loadPublishable(subject);
  if (!current) return { changed: false, reason: 'The reported object no longer exists' };

  const update: PublishableState = {};
  const previousState: ModerationPreviousState = {};

  if (current.isPublished !== true) {
    const restriction = await lastApplied(subject, 'restrict');
    if (restriction) {
      update.isPublished = restriction.previousState?.isPublished ?? true;
      previousState.isPublished = false;
    }
  }

  if (subject.type === ReportedType.AGENT) {
    const demotion = await lastApplied(subject, 'demote');
    if (demotion?.previousState) {
      if (demotion.previousState.isFeatured === true && current.isFeatured !== true) {
        update.isFeatured = true;
        previousState.isFeatured = false;
      }
      if (demotion.previousState.isTrending === true && current.isTrending !== true) {
        update.isTrending = true;
        previousState.isTrending = false;
      }
    }
  }

  if (Object.keys(update).length === 0) {
    return { changed: false, reason: 'There was no earlier enforcement to undo' };
  }
  await updatePublishable(subject, update);
  return { changed: true, previousState };
}

/**
 * The effect of one action, or why there was none.
 *
 * A `changed: false` result means the action was claimed and correctly did nothing
 * — the object is already gone, or there was nothing to undo — which is a
 * different thing from a failure and is recorded as such.
 */
async function applyEffect(
  action: ModerationEnforcementAction,
  subject: EnforcementSubject,
): Promise<EffectResult> {
  switch (action) {
    case 'none':
    case 'manual_review':
      return { changed: false, reason: `Action '${action}' has no effect by definition` };
    case 'restrict':
      return subject.type === ReportedType.AGENT_REVIEW
        ? await hideReview(subject)
        : await restrictPublishable(subject);
    case 'demote':
      return await demote(subject);
    case 'restore':
      return await restore(subject);
  }
}

/**
 * Whether the current mode allows this action to actually happen.
 *
 * `observe` allows nothing — that is the mode. `manual` allows only `restore`:
 * putting something back gives it BACK, and holding that behind a human review
 * means a wrongly-removed agent stays removed while somebody reads a queue. Taking
 * anything down or demoting it still waits for a person. `automatic` allows the
 * mapped set.
 */
function modeAllows(
  mode: ModerationEnforcementMode,
  action: ModerationEnforcementAction,
): boolean {
  switch (mode) {
    case 'observe':
      return false;
    case 'manual':
      return action === 'restore';
    case 'automatic':
      return true;
  }
}

export interface ApplyDecisionEnforcementInput {
  decision: Decision;
  caseId: string;
  subject: EnforcementSubject;
  /** Defaults to the configured mode. Explicit in tests. */
  mode?: ModerationEnforcementMode;
}

/**
 * Plan and carry out everything this decision revision asks for.
 *
 * Returns one outcome per planned action, in plan order, so a caller can record
 * what happened without asking a second time.
 */
export async function applyDecisionEnforcement(
  input: ApplyDecisionEnforcementInput,
): Promise<EnforcementOutcome[]> {
  const mode = input.mode ?? crowdSourceConfig().enforcementMode;
  const plan = planEnforcement(input.decision);
  const outcomes: EnforcementOutcome[] = [];

  for (const planned of plan) {
    outcomes.push(await applyOne(planned, input, mode));
  }
  return outcomes;
}

function countEnforcement(
  action: ModerationEnforcementAction,
  mode: ModerationEnforcementMode,
  result: EnforcementOutcome['result'],
): void {
  recordMetric({
    name: 'crowdsource_enforcement_total',
    value: 1,
    labels: { action, mode, result },
  });
}

async function applyOne(
  planned: PlannedEnforcementAction,
  input: ApplyDecisionEnforcementInput,
  mode: ModerationEnforcementMode,
): Promise<EnforcementOutcome> {
  const { decision, caseId, subject } = input;

  /**
   * The claim. The unique constraint refuses a second row for this
   * `decisionId + revision + action`, so losing this insert is the answer
   * "another delivery already handled it" and not an error.
   *
   * `null` rather than a caught duplicate-key error, and that is the whole
   * difference from the Mongo version: `ON CONFLICT DO NOTHING … RETURNING`
   * means no statement fails, so a genuine failure — a dropped connection, an
   * exhausted pool — still propagates instead of being read as "already
   * enforced" and silently retiring a decision nobody carried out.
   */
  const recordId = await claimEnforcement({
    decisionId: decision.id,
    decisionRevision: decision.revision,
    action: planned.action,
    caseId,
    subjectType: subject.type,
    subjectId: subject.id,
    outcome: decision.outcome,
    ...(planned.recommendedAction === undefined
      ? {}
      : { recommendedAction: planned.recommendedAction }),
    reason: planned.reason,
    mode,
  });
  if (recordId === null) {
    countEnforcement(planned.action, mode, 'duplicate');
    return { action: planned.action, result: 'duplicate' };
  }

  if (!modeAllows(mode, planned.action)) {
    await recordEnforcementSkipped(
      recordId,
      mode === 'observe'
        ? 'observe mode: recorded, not applied'
        : `${mode} mode does not apply '${planned.action}' automatically`,
    );
    countEnforcement(planned.action, mode, 'recorded');
    return { action: planned.action, result: 'recorded' };
  }

  try {
    const effect = await applyEffect(planned.action, subject);
    if (!effect.changed) {
      await recordEnforcementSkipped(recordId, effect.reason);
      countEnforcement(planned.action, mode, 'recorded');
      return { action: planned.action, result: 'recorded' };
    }

    await recordEnforcementApplied(recordId, effect.previousState);
    countEnforcement(planned.action, mode, 'applied');
    return { action: planned.action, result: 'applied' };
  } catch (error: unknown) {
    /**
     * The claim goes back so a retry can try again. Keeping it would make a
     * transient failure permanent: the action would be deduplicated away forever
     * and the decision would silently never be carried out.
     */
    await releaseEnforcementClaim(recordId);
    log.general.error(
      {
        decisionId: decision.id,
        revision: decision.revision,
        action: planned.action,
        error: error instanceof Error ? error.message : String(error),
      },
      '[CrowdSource] enforcement effect failed, claim released',
    );
    throw error;
  }
}
