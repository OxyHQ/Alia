import { describe, expect, it } from 'vitest';
import { TaxonomyCodeSchema } from '@oxyhq/crowdsource-contracts';
import { REPORT_TAXONOMY_VERSION, allegationsForCategories } from '../report-taxonomy.js';
import { ReportCategory } from '../../../value-sets/report.js';

describe('allegationsForCategories', () => {
  it('emits a valid universal code for every category Alia offers', () => {
    for (const category of Object.values(ReportCategory)) {
      const codes = allegationsForCategories([category]);
      expect(codes).toHaveLength(1);
      expect(TaxonomyCodeSchema.safeParse(codes[0]).success).toBe(true);
    }
  });

  it('maps Alia impersonation to the integrity code rather than to a catch-all', () => {
    expect(allegationsForCategories([ReportCategory.IMPERSONATION])).toEqual([
      'integrity.impersonation',
    ]);
  });

  /**
   * Alia's distinctive category. `platform_abuse.automation_abuse` is the claim
   * "a published automation is being used for something it should not be", which
   * is what a reporter means when they say an agent is built to cause harm. The
   * alternatives would each say something the reporter did not:
   * `violence.instruction` and `self_harm.instruction` name a specific harm, and
   * `other.policy_specific` throws away a family the taxonomy does have.
   */
  it('maps malicious instructions to platform abuse, not to a specific harm', () => {
    const codes = allegationsForCategories([ReportCategory.MALICIOUS_INSTRUCTIONS]);
    expect(codes).toEqual(['platform_abuse.automation_abuse']);
    expect(codes).not.toContain('violence.instruction');
    expect(codes).not.toContain('self_harm.instruction');
    expect(codes).not.toContain('other.policy_specific');
  });

  it('reads "explicit" as the stronger claim', () => {
    expect(allegationsForCategories([ReportCategory.EXPLICIT_CONTENT])).toEqual([
      'sexual_content.explicit_activity',
    ]);
  });

  /**
   * Order is not cosmetic. Ingress fingerprints the whole envelope to detect
   * §10.5's "same external id, different body", so a list whose order followed the
   * client's would turn a legitimate outbox retry into a permanent 409 — days
   * later, as a report silently stuck in a queue.
   */
  it('produces the same bytes whatever order the client sent', () => {
    const forwards = allegationsForCategories([
      ReportCategory.SPAM,
      ReportCategory.HARASSMENT,
      ReportCategory.HATE_SPEECH,
    ]);
    const backwards = allegationsForCategories([
      ReportCategory.HATE_SPEECH,
      ReportCategory.HARASSMENT,
      ReportCategory.SPAM,
    ]);
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual([...forwards].sort());
  });

  it('deduplicates categories that share a code', () => {
    expect(
      allegationsForCategories([ReportCategory.SPAM, ReportCategory.SPAM]),
    ).toHaveLength(1);
  });

  /** A report with no allegation is not a report. */
  it('never yields an empty allegation list for a non-empty category list', () => {
    expect(allegationsForCategories([ReportCategory.OTHER]).length).toBeGreaterThan(0);
  });

  it('carries a version so a case can be read back against this mapping', () => {
    expect(REPORT_TAXONOMY_VERSION).toMatch(/^\d{4}\.\d{2}$/);
  });
});
