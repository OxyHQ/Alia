import { CONTRACT_LIMITS } from '@oxyhq/crowdsource-contracts';
import { getDb } from '../../../db/index.js';
import { findReportedSkill, type ModerationSkill } from '../../../db/agents/skillRepository.js';
import { ReportedType } from '../../../domain/report.js';
import type {
  ModerationContextResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

/**
 * A published community skill, as universal material.
 *
 * A skill is a titled, described, published prompt template, so it is described as
 * a `listing`: title and description, and nothing else the contract's listing
 * shape offers. There is no price on a skill, which is what makes `listing` usable
 * here where it is not usable for an agent — `price` and `currency` must travel
 * together and omitting both is valid.
 *
 * As with an agent, the instructions travel as `evidence` context rather than as
 * the subject's own content. The listing is what the skill claims to do; the
 * prompt is what it actually does, and a `malicious_instructions` report is about
 * the second.
 *
 * ## Only a skill with an AUTHOR is reportable material, and the guard is here
 *
 * `skills` holds two populations: the shared catalogue, which has no owner —
 * built-ins Alia ships and skills synced from upstream repositories — and skills
 * an account wrote and published. Only the second is somebody's published work
 * with an author who can answer for it. A report about a catalogue skill is a
 * complaint about what Alia distributes and belongs in a support channel rather
 * than in front of a jury drawn to judge a person, so this returns `null` for
 * one; the delivery worker treats that exactly like a deleted object.
 *
 * An imported skill raises a question this provider does not answer: its author
 * is a repository, not an Oxy account. Such a skill is in the catalogue and
 * therefore ownerless, so it takes the same path — the remedy for a bad upstream
 * skill is removing it from the registry, not judging a stranger who never
 * agreed to be judged here.
 *
 * A skill has TWO public identifiers — the `name` in every URL and the row id in
 * every payload — and a reporter's client could honestly send either. Resolving
 * both is `findReportedSkill`'s job.
 */

const WEB_ORIGIN = process.env.WEB_URL || 'https://alia.onl';

/** The instructions the skill installs, as supporting material. */
function instructionsContext(skill: ModerationSkill): ModerationContextResource | null {
  const prompt = skill.body.trim();
  if (!prompt) return null;
  return {
    role: 'evidence',
    type: 'text',
    data: { text: prompt.slice(0, CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH) },
  };
}

export function createSkillSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.SKILL,
    subjectType: 'custom.alia.skill',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      const skill = await findReportedSkill(getDb(), reportedId);
      if (!skill) return null;
      if (skill.ownerOxyUserId === null) return null;

      const title = skill.displayName.trim();
      /**
       * A listing must have a title. `display_name` is NOT NULL and the routes
       * refuse an empty one, so this is a corrupted row rather than a case to
       * describe, and describing it with an invented title would put words in
       * the author's mouth.
       */
      if (!title) return null;

      const description = skill.description.trim();
      const context = instructionsContext(skill);

      return {
        subject: {
          /**
           * The row id, not the `name`. The external id is what §7.3's dedup key
           * is computed over, and while `name` is immutable today, the row id is
           * what nothing can ever change.
           */
          externalId: skill.id,
          type: 'custom.alia.skill',
          permalink: `${WEB_ORIGIN}/skills/${skill.name}`,
          author: { oxyUserId: skill.ownerOxyUserId },
        },
        content: {
          type: 'listing',
          data: {
            title: title.slice(0, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH),
            ...(description
              ? { description: description.slice(0, CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH) }
              : {}),
          },
          createdAt: skill.createdAt,
        },
        ...(context === null ? {} : { context: [context] }),
      };
    },
  };
}
