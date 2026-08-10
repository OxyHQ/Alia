import mongoose from 'mongoose';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import { Agent } from '../../models/agent.js';
import { AgentReview } from '../../models/agent-review.js';
import { Skill } from '../../models/skill.js';
import { ReportedType } from '../../domain/report.js';
import { ModerationEnforcement, type IModerationEnforcement, type ModerationPreviousState } from '../../models/moderation-enforcement.js';
import { type ModerationEnforcementAction } from '../../domain/moderation-enforcement.js';
import { recalculateAgentRating } from '../agent-rating.js';
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

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
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
): Promise<Pick<IModerationEnforcement, 'previousState'> | null> {
  return await ModerationEnforcement.findOne({
    subjectType: subject.type,
    subjectId: subject.id,
    action,
    applied: true,
  })
    .sort({ createdAt: -1 })
    .lean<Pick<IModerationEnforcement, 'previousState'> | null>();
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
 * Mongoose document types genuinely are not assignable to a common one — and a
 * cast there would silently keep compiling if either model dropped the field. Two
 * branches of three lines each cost nothing and stay honest with the schemas.
 */
async function loadPublishable(
  subject: EnforcementSubject,
): Promise<PublishableState | null> {
  if (!mongoose.isValidObjectId(subject.id)) return null;
  const projection = 'isPublished isFeatured isTrending';
  if (subject.type === ReportedType.AGENT) {
    return await Agent.findById(subject.id)
      .select(projection)
      .lean<PublishableState | null>();
  }
  if (subject.type === ReportedType.SKILL) {
    return await Skill.findById(subject.id)
      .select(projection)
      .lean<PublishableState | null>();
  }
  return null;
}

/** Whether this subject type has a catalog row to publish or unpublish at all. */
function isPublishableType(subjectType: string): boolean {
  return subjectType === ReportedType.AGENT || subjectType === ReportedType.SKILL;
}

async function updatePublishable(
  subject: EnforcementSubject,
  update: PublishableState,
): Promise<void> {
  if (subject.type === ReportedType.AGENT) {
    await Agent.updateOne({ _id: subject.id }, { $set: update });
    return;
  }
  await Skill.updateOne({ _id: subject.id }, { $set: update });
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
  await Agent.updateOne(
    { _id: subject.id },
    { $set: { isFeatured: false, isTrending: false } },
  );
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
  if (!mongoose.isValidObjectId(subject.id)) {
    return { changed: false, reason: 'The reported review no longer exists' };
  }
  const review = await AgentReview.findById(subject.id)
    .select('agentId hiddenByModeration')
    .lean<{ agentId?: mongoose.Types.ObjectId; hiddenByModeration?: boolean } | null>();
  if (!review) return { changed: false, reason: 'The reported review no longer exists' };
  if (review.hiddenByModeration === true) {
    return { changed: false, reason: 'The review was already withheld' };
  }
  await AgentReview.updateOne({ _id: subject.id }, { $set: { hiddenByModeration: true } });
  // The rating is computed from visible reviews, so it has to move with them.
  if (review.agentId) await recalculateAgentRating(review.agentId);
  return { changed: true, previousState: { hiddenByModeration: false } };
}

/** Put a withheld review back, only if MODERATION withheld it. */
async function unhideReview(subject: EnforcementSubject): Promise<EffectResult> {
  if (!mongoose.isValidObjectId(subject.id)) {
    return { changed: false, reason: 'The reported review no longer exists' };
  }
  const review = await AgentReview.findById(subject.id)
    .select('agentId hiddenByModeration')
    .lean<{ agentId?: mongoose.Types.ObjectId; hiddenByModeration?: boolean } | null>();
  if (!review) return { changed: false, reason: 'The reported review no longer exists' };
  if (review.hiddenByModeration !== true) {
    return { changed: false, reason: 'The review was not withheld' };
  }
  await AgentReview.updateOne({ _id: subject.id }, { $set: { hiddenByModeration: false } });
  if (review.agentId) await recalculateAgentRating(review.agentId);
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
   * The claim. The unique index refuses a second row for this
   * `decisionId + revision + action`, so losing this insert is the answer "another
   * delivery already handled it" and not an error.
   */
  let record: IModerationEnforcement;
  try {
    record = await ModerationEnforcement.create({
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
      applied: false,
    });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      countEnforcement(planned.action, mode, 'duplicate');
      return { action: planned.action, result: 'duplicate' };
    }
    throw error;
  }

  if (!modeAllows(mode, planned.action)) {
    await ModerationEnforcement.updateOne(
      { _id: record._id },
      {
        $set: {
          skippedReason:
            mode === 'observe'
              ? 'observe mode: recorded, not applied'
              : `${mode} mode does not apply '${planned.action}' automatically`,
        },
      },
    );
    countEnforcement(planned.action, mode, 'recorded');
    return { action: planned.action, result: 'recorded' };
  }

  try {
    const effect = await applyEffect(planned.action, subject);
    if (!effect.changed) {
      await ModerationEnforcement.updateOne(
        { _id: record._id },
        { $set: { skippedReason: effect.reason } },
      );
      countEnforcement(planned.action, mode, 'recorded');
      return { action: planned.action, result: 'recorded' };
    }

    await ModerationEnforcement.updateOne(
      { _id: record._id },
      {
        $set: {
          applied: true,
          appliedAt: new Date(),
          previousState: effect.previousState,
        },
      },
    );
    countEnforcement(planned.action, mode, 'applied');
    return { action: planned.action, result: 'applied' };
  } catch (error: unknown) {
    /**
     * The claim goes back so a retry can try again. Keeping it would make a
     * transient failure permanent: the action would be deduplicated away forever
     * and the decision would silently never be carried out.
     */
    await ModerationEnforcement.deleteOne({ _id: record._id });
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
