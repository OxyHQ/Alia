import { describe, expect, it } from 'vitest';
import { DECISION_OUTCOMES, DECISION_STATUSES } from '@oxyhq/crowdsource-contracts';
import { legacyStatusForOutcome, reportStateForDecision } from '../report-status.js';
import { ReportStatus } from '../../../domain/report.js';

describe('reportStateForDecision', () => {
  it('resolves a violation and dismisses a no_violation', () => {
    expect(legacyStatusForOutcome('violation')).toBe(ReportStatus.RESOLVED);
    expect(legacyStatusForOutcome('no_violation')).toBe(ReportStatus.DISMISSED);
  });

  /**
   * The collapse the invariants forbid. `inconclusive` means a jury engaged and
   * did not reach the threshold; `dismissed` means the allegation was not upheld.
   * Mapping the first to the second turns "we could not tell" into "nothing was
   * wrong" — absence of consensus is neither guilt nor innocence.
   */
  it('never turns a non-verdict into a verdict', () => {
    for (const outcome of [
      'insufficient_context',
      'inconclusive',
      'content_unavailable',
      'duplicate',
      'escalated',
    ]) {
      expect(legacyStatusForOutcome(outcome)).toBe(ReportStatus.REVIEWED);
    }
  });

  it('reviews, never dismisses, an outcome this version does not know', () => {
    expect(legacyStatusForOutcome('a_future_outcome')).toBe(ReportStatus.REVIEWED);
  });

  it('handles every outcome the contract defines', () => {
    for (const outcome of DECISION_OUTCOMES) {
      expect(Object.values(ReportStatus)).toContain(legacyStatusForOutcome(outcome));
    }
  });

  describe('local status', () => {
    it('closes on a final or corrected decision', () => {
      for (const decisionStatus of ['final', 'corrected']) {
        expect(
          reportStateForDecision({ outcome: 'violation', decisionStatus }).localStatus,
        ).toBe('closed');
      }
    });

    /**
     * A provisional decision is real and is recorded, but §9.6 allows a later
     * revision to supersede it — a report Alia had already closed would have to be
     * reopened. A `superseded` revision is not the current answer at all, so it
     * must never be the one that closes the report either.
     */
    it('leaves the report open on provisional and superseded', () => {
      for (const decisionStatus of ['provisional', 'superseded']) {
        expect(
          reportStateForDecision({ outcome: 'violation', decisionStatus }).localStatus,
        ).toBe('submitted');
      }
    });

    it('handles every decision status the contract defines', () => {
      for (const decisionStatus of DECISION_STATUSES) {
        const state = reportStateForDecision({ outcome: 'violation', decisionStatus });
        expect(['closed', 'submitted']).toContain(state.localStatus);
      }
    });
  });
});
