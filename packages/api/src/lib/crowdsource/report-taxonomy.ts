import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import { ReportCategory } from '../../models/report.js';

/**
 * Alia's report categories, translated into CrowdSource's universal taxonomy.
 *
 * The categories on the left are what a reporter picked in Alia's UI. The codes on
 * the right are ALLEGATIONS (§6.2) — what is claimed, never what is true. A jury
 * classifies the material itself and may confirm a different code entirely, and
 * nothing about this table shortens that.
 *
 * ## Why this is versioned
 *
 * §6.4 requires every decision to record the policy version it was decided under,
 * and this mapping is upstream of that: change what `spam` means and two reports
 * filed a month apart are no longer the same allegation.
 * {@link REPORT_TAXONOMY_VERSION} is stamped into the report metadata so a case
 * can always be read back against the mapping that produced it. Bump it in the
 * same change that alters a row.
 *
 * ## The row worth arguing about
 *
 * **`malicious_instructions` maps to `platform_abuse.automation_abuse`.** This is
 * Alia's distinctive category and it has no obvious home: the reporter is claiming
 * that a published agent or skill is BUILT to produce harm, which is a claim about
 * the instructions rather than about anything the instructions have yet produced.
 *
 * The tempting alternatives are both wrong. `violence.instruction` and
 * `self_harm.instruction` name specific harms the reporter usually is not
 * alleging, and picking one would tell a jury the reporter said something more
 * precise than they did. `other.policy_specific` — the escape hatch for "against
 * this application's rules, and the universal taxonomy has no name for it" — would
 * be the honest fallback if nothing fitted, but something does:
 * `platform_abuse.automation_abuse` is a claim that a published automation is
 * being used for something it should not be, and a persona whose system prompt
 * exists to generate abuse at scale is exactly that. It also puts the report in
 * the `platform_abuse` family, where §9.4's family-level consensus groups it with
 * the other "this account/automation is being misused" claims rather than with a
 * content verdict the material may not support.
 *
 * `explicit_content` maps to the activity code rather than the nudity code for the
 * same reason it does elsewhere in the ecosystem: Alia's UI offers one button for
 * two distinct claims, the stronger one is the honest reading of "explicit", and a
 * jury that finds only nudity will say so — whereas alleging nudity when explicit
 * activity was reported understates the report and could route it to a lighter
 * review.
 */
export const REPORT_TAXONOMY_VERSION = '2026.07';

const CATEGORY_TO_ALLEGATION: Readonly<Record<ReportCategory, TaxonomyCode>> =
  Object.freeze({
    [ReportCategory.SPAM]: 'integrity.spam',
    [ReportCategory.HARASSMENT]: 'harassment.targeted_abuse',
    [ReportCategory.HATE_SPEECH]: 'hate.protected_targeting',
    [ReportCategory.EXPLICIT_CONTENT]: 'sexual_content.explicit_activity',
    [ReportCategory.IMPERSONATION]: 'integrity.impersonation',
    [ReportCategory.MALICIOUS_INSTRUCTIONS]: 'platform_abuse.automation_abuse',
    [ReportCategory.OTHER]: 'other.unclassifiable',
  });

/**
 * The allegation codes for a report's categories, deduplicated and ORDERED.
 *
 * Order is not cosmetic. Ingress fingerprints the whole envelope to detect §10.5's
 * "same external id, different body", so a list whose order depended on how a
 * client happened to send its categories would turn a legitimate outbox retry into
 * a permanent 409 — days later, as a report silently stuck in a queue. Sorting
 * makes the same report produce the same bytes every time.
 */
export function allegationsForCategories(
  categories: readonly ReportCategory[],
): TaxonomyCode[] {
  const codes = new Set<TaxonomyCode>();
  for (const category of categories) {
    const code = CATEGORY_TO_ALLEGATION[category];
    // A category the map does not cover cannot silently become nothing: a report
    // with no allegation is not a report. `other.unclassifiable` is what the
    // universal taxonomy provides for exactly this.
    codes.add(code ?? 'other.unclassifiable');
  }
  return Array.from(codes).sort();
}
