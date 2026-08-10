import { describe, expect, it } from 'vitest';
import { decisionFixture } from '@oxyhq/crowdsource-testing';
import {
  RECOMMENDED_ACTIONS,
  type Decision,
  type RecommendedAction,
} from '@oxyhq/crowdsource-contracts';
import { planEnforcement } from '../enforcement-plan.js';
import { MODERATION_ENFORCEMENT_ACTIONS } from '../../../value-sets/moderation-enforcement.js';

/**
 * `planEnforcement` is pure, so it can be pinned as a table. That is the whole
 * reason it is pure: the alternative is proving these mappings through a database,
 * a webhook and an enforcement run, which tests the plumbing and not the policy.
 */

function withRecommendations(
  actions: readonly RecommendedAction[],
  outcome: Decision['outcome'] = 'violation',
): Decision {
  return {
    ...decisionFixture({ outcome }),
    recommendedActions: actions.map((action) => ({ action })),
  };
}

describe('planEnforcement', () => {
  describe('recommendation mapping', () => {
    const cases: ReadonlyArray<[RecommendedAction, string]> = [
      ['remove', 'restrict'],
      ['remove_or_restrict', 'restrict'],
      ['hide', 'restrict'],
      ['reduce_distribution', 'demote'],
      ['allow', 'none'],
      ['no_action', 'none'],
      ['no_global_effect', 'none'],
      ['restore', 'restore'],
      ['suspend_user', 'manual_review'],
      ['freeze_transaction', 'manual_review'],
      ['request_changes', 'manual_review'],
      ['request_more_context', 'manual_review'],
      ['hold', 'manual_review'],
      ['local_manual_review', 'manual_review'],
      ['keep_restricted_temporarily', 'manual_review'],
      ['escalate', 'manual_review'],
      ['specialist_queue', 'manual_review'],
      ['legal_queue', 'manual_review'],
      ['safety_queue', 'manual_review'],
    ];

    for (const [recommendation, expected] of cases) {
      it(`maps ${recommendation} to ${expected}`, () => {
        const plan = planEnforcement(withRecommendations([recommendation]));
        expect(plan.map((entry) => entry.action)).toEqual([expected]);
        expect(plan[0].recommendedAction).toBe(recommendation);
      });
    }

    /**
     * The three that are deliberately NOT folded into an effect Alia does have.
     *
     * Alia renders no content warning, spoiler or age gate anywhere. `demote` is
     * the nearest available lever and using it would record "we warned the user"
     * when what happened was "we made it slightly harder to find". If somebody
     * later gives Alia a real warning surface, this test is what tells them to
     * revisit the mapping rather than discover it in an audit.
     */
    for (const recommendation of ['label', 'allow_with_label', 'age_gate'] as const) {
      it(`refuses to invent a warning for ${recommendation}, recording manual_review`, () => {
        const plan = planEnforcement(withRecommendations([recommendation]));
        expect(plan.map((entry) => entry.action)).toEqual(['manual_review']);
        expect(plan.map((entry) => entry.action)).not.toContain('demote');
      });
    }

    it('covers every recommendation the contract can send', () => {
      for (const action of RECOMMENDED_ACTIONS) {
        const plan = planEnforcement(withRecommendations([action]));
        expect(plan.length).toBeGreaterThan(0);
        for (const entry of plan) {
          expect(MODERATION_ENFORCEMENT_ACTIONS).toContain(entry.action);
        }
      }
    });
  });

  describe('collapsing', () => {
    it('lets restrict absorb demote — one effect happened, one is recorded', () => {
      const plan = planEnforcement(withRecommendations(['remove', 'reduce_distribution']));
      expect(plan.map((entry) => entry.action)).toEqual(['restrict']);
    });

    it('keeps manual_review alongside a real effect', () => {
      const plan = planEnforcement(withRecommendations(['remove', 'suspend_user']));
      expect(plan.map((entry) => entry.action).sort()).toEqual([
        'manual_review',
        'restrict',
      ]);
    });

    it('drops none when anything else is planned', () => {
      const plan = planEnforcement(withRecommendations(['allow', 'reduce_distribution']));
      expect(plan.map((entry) => entry.action)).toEqual(['demote']);
    });

    it('never returns an empty plan', () => {
      const plan = planEnforcement(withRecommendations(['allow']));
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe('none');
    });
  });

  describe('no_violation always restores', () => {
    /**
     * The failure this guards is very easy to ship and impossible to see. A
     * correction is a revision whose outcome is `no_violation` and whose
     * recommendation is frequently `no_action` — "take no NEW action", not "leave
     * what you already did in place". Mapping it straight through plans `none`,
     * and the agent an earlier revision unpublished stays unpublished forever with
     * no error anywhere.
     */
    it('adds a restore even when the recommendation is no_action', () => {
      const plan = planEnforcement(withRecommendations(['no_action'], 'no_violation'));
      expect(plan.map((entry) => entry.action)).toContain('restore');
    });

    it('adds a restore even when the recommendation is allow', () => {
      const plan = planEnforcement(withRecommendations(['allow'], 'no_violation'));
      expect(plan.map((entry) => entry.action)).toContain('restore');
    });

    it('does not duplicate an explicit restore', () => {
      const plan = planEnforcement(withRecommendations(['restore'], 'no_violation'));
      expect(plan.filter((entry) => entry.action === 'restore')).toHaveLength(1);
    });

    it('restores when the decision recommended nothing at all', () => {
      const decision: Decision = {
        ...decisionFixture({ outcome: 'no_violation' }),
        recommendedActions: [],
      };
      expect(planEnforcement(decision).map((entry) => entry.action)).toEqual(['restore']);
    });
  });

  describe('severity fallback for a violation with no recommendation', () => {
    function violationWithSeverity(severity: 'low' | 'medium' | 'high' | 'critical'): Decision {
      const base = decisionFixture({ outcome: 'violation' });
      return {
        ...base,
        recommendedActions: [],
        findings: base.findings.map((finding) => ({ ...finding, severity })),
      };
    }

    it('restricts on high', () => {
      expect(planEnforcement(violationWithSeverity('high')).map((e) => e.action)).toEqual([
        'restrict',
      ]);
    });

    it('demotes on medium', () => {
      expect(planEnforcement(violationWithSeverity('medium')).map((e) => e.action)).toEqual([
        'demote',
      ]);
    });

    /**
     * Both ends go to a human, and for different reasons: `low` is not worth
     * unpublishing somebody's work over, and `critical` is specialist/legal
     * territory that a webhook-driven removal is not.
     */
    it('asks a human on low', () => {
      expect(planEnforcement(violationWithSeverity('low')).map((e) => e.action)).toEqual([
        'manual_review',
      ]);
    });

    it('asks a human on critical rather than removing automatically', () => {
      expect(
        planEnforcement(violationWithSeverity('critical')).map((e) => e.action),
      ).toEqual(['manual_review']);
    });

    it('asks a human when a violation carries no finding this version understands', () => {
      const decision: Decision = {
        ...decisionFixture({ outcome: 'violation' }),
        recommendedActions: [],
        findings: [],
      };
      expect(planEnforcement(decision).map((e) => e.action)).toEqual(['manual_review']);
    });
  });

  describe('outcomes with no recommendation', () => {
    function bare(outcome: Decision['outcome']): Decision {
      return { ...decisionFixture({ outcome: 'no_violation' }), outcome, recommendedActions: [] };
    }

    /**
     * Absence of consensus is neither guilt nor innocence. None of these may
     * produce an effect on their own, and none may look like `no_violation`.
     */
    for (const outcome of ['insufficient_context', 'inconclusive', 'escalated'] as const) {
      it(`asks a human on ${outcome} and changes nothing`, () => {
        const plan = planEnforcement(bare(outcome));
        expect(plan.map((entry) => entry.action)).toEqual(['manual_review']);
        expect(plan.map((entry) => entry.action)).not.toContain('restore');
        expect(plan.map((entry) => entry.action)).not.toContain('restrict');
      });
    }

    for (const outcome of ['content_unavailable', 'duplicate'] as const) {
      it(`plans an explicit none on ${outcome}`, () => {
        expect(planEnforcement(bare(outcome)).map((entry) => entry.action)).toEqual(['none']);
      });
    }

    /**
     * §10.11: a newer CrowdSource must not break an older client. The safe reading
     * of an outcome this version has never seen is a human, never a default effect.
     */
    it('asks a human for an outcome this version does not know', () => {
      const decision: Decision = {
        ...decisionFixture(),
        recommendedActions: [],
        outcome: 'a_future_outcome' as Decision['outcome'],
      };
      expect(planEnforcement(decision).map((entry) => entry.action)).toEqual([
        'manual_review',
      ]);
    });
  });
});
