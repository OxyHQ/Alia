import type { Decision, RecommendedAction, Severity } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementAction } from '../../value-sets/moderation-enforcement.js';

/**
 * Deciding what Alia will do about a decision — and nothing else.
 *
 * Pure: no database, no clock, no configuration. A decision in, a plan out. That
 * is what makes the mapping testable as a table rather than as an integration
 * scenario, and it is why `observe` mode is a real audit rather than a comment —
 * the plan is computed identically in every mode and only its EXECUTION is gated.
 *
 * ## Alia maps recommendations, not findings
 *
 * The jury classified the material and the consensus engine turned that into a
 * recommendation under a versioned policy (§7.6). An application that re-derived
 * its action from raw severity would be quietly re-deciding the case with a
 * second, unversioned policy of its own — and the two would diverge the first time
 * CrowdSource's policy was updated. Severity is a fallback only, for a `violation`
 * that arrives with no recommendation at all, because a violation Alia did nothing
 * about would be worse than a mapped one.
 *
 * ## Alia's three primitives, and the one it deliberately does NOT have
 *
 * - `restrict` — the artefact leaves the catalog. `Agent.isPublished` and
 *   `Skill.isPublished` are already the gate every public read applies, and
 *   `AgentReview.hiddenByModeration` is the same idea for a review, so this
 *   removes the object from listing, detail and search at once with no query to
 *   edit — and `restore` puts it back exactly as it was.
 * - `demote` — editorial promotion is removed (`isFeatured`, `isTrending`) without
 *   unpublishing. This is a REAL distribution reduction, which is why
 *   `reduce_distribution` maps here rather than to a human queue.
 * - `manual_review` — recorded, never executed automatically.
 *
 * **There is no `label_sensitive`, and adding one would be a lie.** Alia renders
 * no content warning, no spoiler and no age gate anywhere in its catalog surfaces.
 * The tempting move — the one a neighbouring application makes because it HAS a
 * sensitive flag — is to fold `label`, `allow_with_label` and `age_gate` into the
 * nearest available effect. Here the nearest available effect is `demote`, and
 * using it would record "we warned the user" when what happened was "we made it
 * slightly harder to find". §7.6 lets an application refuse or adapt a
 * recommendation provided it records what it did, so these are `manual_review`:
 * recorded, visible, and honest about needing a person. A declined recommendation
 * must never look like one that never arrived.
 *
 * `suspend_user` is Oxy's to carry out, not Alia's; `legal_queue` needs a human.
 * Same treatment, same reason.
 */

export interface PlannedEnforcementAction {
  readonly action: ModerationEnforcementAction;
  /** Why, in words an operator reads. Never reported material. */
  readonly reason: string;
  /** The recommendation this came from, when it came from one. */
  readonly recommendedAction?: RecommendedAction;
}

/** What a recommended action becomes in Alia. */
const RECOMMENDATION_TO_ACTION: Readonly<
  Record<RecommendedAction, ModerationEnforcementAction>
> = Object.freeze({
  remove: 'restrict',
  remove_or_restrict: 'restrict',
  hide: 'restrict',

  reduce_distribution: 'demote',

  allow: 'none',
  no_action: 'none',
  no_global_effect: 'none',
  restore: 'restore',

  // Alia can display no warning of any kind. Recorded for a human rather than
  // silently downgraded to the nearest effect it does have.
  label: 'manual_review',
  allow_with_label: 'manual_review',
  age_gate: 'manual_review',

  // Alia holds none of the levers these ask for. Recorded, queued for a human.
  suspend_user: 'manual_review',
  freeze_transaction: 'manual_review',
  request_changes: 'manual_review',
  request_more_context: 'manual_review',
  hold: 'manual_review',
  local_manual_review: 'manual_review',
  keep_restricted_temporarily: 'manual_review',
  escalate: 'manual_review',
  specialist_queue: 'manual_review',
  legal_queue: 'manual_review',
  safety_queue: 'manual_review',
});

/**
 * The action a violation gets when the decision recommended nothing.
 *
 * Severity only, and deliberately cautious at both ends. A `low`-severity
 * violation with no recommendation is not something to unpublish somebody's work
 * over, so it goes to a human; `critical` goes to a human too, because §7.5 routes
 * that material to a specialist team under legal protocol and an automatic removal
 * driven by a webhook is not that. The difference between them is a policy decision
 * with legal weight, and a mapping table is the wrong place to make it.
 */
const SEVERITY_FALLBACK: Readonly<Record<Severity, ModerationEnforcementAction>> =
  Object.freeze({
    critical: 'manual_review',
    high: 'restrict',
    medium: 'demote',
    low: 'manual_review',
  });

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

function highestSeverity(decision: Decision): Severity | undefined {
  let highest: Severity | undefined;
  for (const finding of decision.findings) {
    if (
      highest === undefined ||
      SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(highest)
    ) {
      highest = finding.severity;
    }
  }
  return highest;
}

/**
 * `no_violation` always carries a restore, whatever it recommended.
 *
 * This exists because of a failure that is very easy to ship and very hard to see.
 * A correction is a new revision whose outcome is `no_violation`, and its
 * recommendation is frequently `no_action` — which is CrowdSource saying "take no
 * NEW action", not "leave what you already did in place". Mapping that straight
 * through plans `none`, and the agent an earlier revision unpublished stays
 * unpublished forever: the appeal succeeded, the case says the listing was fine,
 * and nothing in Alia ever puts it back. No error, no log line, no failing test
 * anywhere else.
 *
 * §7.6 lists `allow`, `restore` and `no_action` together as the application's
 * options for `no_violation` precisely because choosing between them needs
 * knowledge only the application has — whether it did something earlier. So the
 * plan always includes the restore, and the executor records "there was nothing to
 * undo" when that is the case, which is evidence rather than a silent no-op.
 */
function withRestoreForNoViolation(
  decision: Decision,
  planned: readonly PlannedEnforcementAction[],
): readonly PlannedEnforcementAction[] {
  if (decision.outcome !== 'no_violation') return planned;
  if (planned.some((entry) => entry.action === 'restore')) return planned;
  return [
    ...planned,
    { action: 'restore', reason: 'No violation: undo any earlier enforcement' },
  ];
}

/**
 * Collapse a plan to the actions that can coexist.
 *
 * A decision may recommend both removal and reduced distribution; an unpublished
 * agent is not in any ranking, and recording both would claim two effects where
 * one happened. `restrict` therefore absorbs `demote`, `none` and `restore`, and
 * `none` never survives alongside anything else. `manual_review` always survives —
 * it is a note for a human, and dropping it because something else was also done
 * is how a `suspend_user` recommendation gets lost.
 */
function collapse(
  actions: readonly PlannedEnforcementAction[],
): PlannedEnforcementAction[] {
  const byAction = new Map<ModerationEnforcementAction, PlannedEnforcementAction>();
  for (const planned of actions) {
    if (!byAction.has(planned.action)) byAction.set(planned.action, planned);
  }

  if (byAction.has('restrict')) {
    byAction.delete('demote');
    byAction.delete('none');
    byAction.delete('restore');
  }
  if (byAction.size > 1) byAction.delete('none');

  return Array.from(byAction.values());
}

/**
 * What Alia will do about this decision.
 *
 * Never empty: a decision that produces no action produces an explicit `none`,
 * because a row saying "we decided to do nothing, and why" is evidence and an
 * absent row is a question.
 */
export function planEnforcement(decision: Decision): PlannedEnforcementAction[] {
  const fromRecommendations = decision.recommendedActions.map(
    (recommended): PlannedEnforcementAction => ({
      action: RECOMMENDATION_TO_ACTION[recommended.action] ?? 'manual_review',
      reason: `CrowdSource recommended ${recommended.action}`,
      recommendedAction: recommended.action,
    }),
  );

  if (fromRecommendations.length > 0) {
    const collapsed = collapse(withRestoreForNoViolation(decision, fromRecommendations));
    return collapsed.length > 0
      ? collapsed
      : [{ action: 'none', reason: 'No recommended action maps to an Alia effect' }];
  }

  switch (decision.outcome) {
    case 'violation': {
      const severity = highestSeverity(decision);
      /**
       * A `violation` with no findings cannot happen — the contract refuses it —
       * so an absent severity here means a newer CrowdSource sent something this
       * code has not seen. A human looks at it rather than a default unpublishing
       * somebody's work.
       */
      if (severity === undefined) {
        return [
          {
            action: 'manual_review',
            reason: 'Violation carried no finding severity this version understands',
          },
        ];
      }
      return [
        {
          action: SEVERITY_FALLBACK[severity],
          reason: `Violation with no recommended action, highest severity ${severity}`,
        },
      ];
    }

    case 'no_violation':
      /**
       * A restore, always planned — even when nothing was enforced. The executor
       * records it as not applied with the reason, which is how "we checked and
       * there was nothing to undo" is distinguishable from "we never looked".
       */
      return [{ action: 'restore', reason: 'No violation: undo any earlier enforcement' }];

    case 'insufficient_context':
    case 'inconclusive':
    case 'escalated':
      /**
       * §7.6 offers `keep_restricted_temporarily`, `escalate` and internal review
       * for these. None of them is "remove", and none is "it was fine": absence of
       * consensus is neither guilt nor innocence, so Alia changes nothing on its
       * own and asks a human.
       */
      return [
        {
          action: 'manual_review',
          reason: `Outcome ${decision.outcome}: no automatic action, internal review`,
        },
      ];

    case 'content_unavailable':
    case 'duplicate':
      return [{ action: 'none', reason: `Outcome ${decision.outcome}: nothing to enforce` }];

    default:
      /**
       * An outcome §9.6 does not currently define. §10.11 requires a newer server
       * not to break an older client, and the safe reading of an unknown outcome
       * is a human, never a default effect.
       */
      return [
        {
          action: 'manual_review',
          reason: 'Decision outcome not recognised by this version of Alia',
        },
      ];
  }
}
