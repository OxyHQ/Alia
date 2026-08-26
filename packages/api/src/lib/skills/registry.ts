/**
 * The curated sources the shared catalogue is synced from.
 *
 * The same shape as `lib/mcp-registry.ts` and for the same reason: a catalogue
 * of third-party things whose membership is a decision somebody makes in a
 * reviewed diff, not a database row anybody can add. Adding a source here is
 * adding a publisher whose instructions Alia will host and offer to every
 * account.
 *
 * ## A source is a repository, and a repository is not a licence
 *
 * Nothing here declares what a skill may be redistributed under, because the
 * repository does not know: `anthropics/skills` holds Apache-2.0 skills and
 * all-rights-reserved ones side by side, under the same path. `sync.ts` reads
 * each bundle's own licence through `redistribution.ts` and skips the ones that
 * do not permit hosting — so the worst a wrong entry here can do is import
 * nothing.
 */

export interface SkillRegistrySource {
  /** Stable id, used in logs and in the sync report. */
  readonly id: string;
  /** `owner/repo`. */
  readonly repo: string;
  /** The directory holding the skills, when the repository does not keep them at its root. */
  readonly path?: string;
  /** A branch or tag to follow. The sync resolves it to a commit on every run. */
  readonly ref?: string;
  /** Who is credited on the catalogue card. */
  readonly publisher: string;
  readonly tags: readonly string[];
  /** Why this source is here, for whoever reviews the next addition. */
  readonly why: string;
}

export const SKILL_REGISTRY: readonly SkillRegistrySource[] = [
  {
    id: 'anthropic-skills',
    repo: 'anthropics/skills',
    path: 'skills',
    publisher: 'Anthropic',
    tags: ['official', 'documents', 'design'],
    why: 'The reference implementations from the authors of the format. Its four document skills (docx, pdf, pptx, xlsx) are all-rights-reserved and are skipped by the licence check, not by a list here.',
  },
  {
    id: 'vercel-ai-sdk',
    repo: 'vercel/ai',
    path: 'skills',
    publisher: 'Vercel',
    tags: ['development', 'ai-sdk'],
    why: 'The AI SDK the API itself runs on. A skill maintained by the library authors beats one written here from its docs.',
  },
  {
    id: 'agent-skills-examples',
    repo: 'agentskills/agentskills',
    path: 'examples',
    publisher: 'Agent Skills',
    tags: ['examples', 'official'],
    why: 'The specification repository\'s own examples, which are what the format is defined by.',
  },
];
