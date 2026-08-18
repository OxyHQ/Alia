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
 * ## Built-in skills are not reportable material, and the guard is here
 *
 * `Skill` holds two populations in one collection: Alia's own seeded skills
 * (`isBuiltIn: true`, no `oxyUserId`) and community skills a user wrote
 * (`isBuiltIn: false`, `isPublished` starting `false`). Only the second is
 * somebody's published work with an author who can answer for it. A report about a
 * built-in skill is a complaint about Alia's own product and belongs in a support
 * channel, not in front of a jury drawn to judge a person — so this returns `null`
 * for one, which the delivery worker treats exactly like a deleted object: the
 * report closes locally with a reason and nothing is sent.
 *
 * A skill has TWO public identifiers — the `skillId` slug in every URL and the
 * `_id` in every payload — and a reporter's client could honestly send either.
 * Resolving both is `findReportedSkill`'s job; see its note for why the
 * `isValidObjectId` guard that used to sit here had to go rather than move.
 */

const WEB_ORIGIN = process.env.WEB_URL || 'https://alia.onl';

/** The prompt the skill installs, as supporting material. */
function instructionsContext(skill: ModerationSkill): ModerationContextResource | null {
  const prompt = skill.systemPrompt.trim();
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
      if (skill.isBuiltIn) return null;

      const title = skill.title.trim();
      /**
       * A listing must have a title. A community skill without one cannot be
       * created through `POST /skills` — the route rejects it — so this is a
       * corrupted row rather than a case to describe, and describing it with an
       * invented title would put words in the author's mouth.
       */
      if (!title) return null;

      const description = [skill.tagline.trim(), skill.description.trim()]
        .filter((part) => Boolean(part))
        .join('\n\n');
      const context = instructionsContext(skill);

      return {
        subject: {
          /**
           * The `_id`, not the `skillId` slug. The external id is what §7.3's
           * dedup key is computed over, and a slug is derived from the title —
           * which the owner can edit. Two reports about one skill either side of a
           * rename must reach the same case.
           */
          externalId: skill.id,
          type: 'custom.alia.skill',
          permalink: `${WEB_ORIGIN}/skills/${skill.skillId}`,
          ...(skill.oxyUserId === null ? {} : { author: { oxyUserId: skill.oxyUserId } }),
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
