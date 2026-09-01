/**
 * The skills Alia ships, seeded from the directory they live in.
 *
 * `packages/api/skills/<name>/SKILL.md` — real Agent Skills, in the format every
 * other client reads, imported through the same pipeline as a GitHub import or
 * an upload. They used to be fifteen TypeScript template literals in a file
 * called `seed-skills.ts`, which meant a built-in could never bundle a reference
 * file or a script, could not be edited without a redeploy, and could not be
 * validated against the format it claimed to implement.
 *
 * ## They go in the SHARED catalogue and are installed by nobody
 *
 * `owner_oxy_user_id` is null and `visibility` is public, so every account can
 * find them; none is installed for anyone. A built-in that reached a turn
 * without somebody choosing it would be exactly the "global sticky skill" this
 * rewrite removed.
 *
 * ## Re-seeding is idempotent by checksum
 *
 * `storeSkillBundle` compares the bundle against the latest stored version and
 * writes nothing when they match, so the seed can run on every deploy without
 * producing a version per deploy. An edited `SKILL.md` produces exactly one new
 * version, and installs that follow the latest pick it up.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../../db/index.js';
import { log } from '../logger.js';
import { readSkillDirectory } from './archive.js';
import { buildSkillBundle } from './bundle.js';
import { storeSkillBundle } from './store.js';

/**
 * Candidate roots for every place esbuild can put the code that calls this
 * module:
 *
 * - source/tests: `src/lib/skills/` -> `../../../skills`
 * - the seed one-shot: `dist/scripts/seed.js` -> `../../skills`
 * - a bundle emitted directly under `dist/` -> `../skills`
 *
 * The middle path is deliberately explicit. The deploy invokes the seed
 * one-shot, whose bundle is one directory deeper than the API bundle; treating
 * both bundles as if they lived directly under `dist/` leaves the skills in the
 * image but makes the seeder look in `/app/packages/skills` and
 * `/app/packages/api/dist/skills` instead.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_ROOTS = [
  join(HERE, '../../../skills'),
  join(HERE, '../../skills'),
  join(HERE, '../skills'),
];

async function resolveSkillsRoot(): Promise<string | null> {
  for (const root of CANDIDATE_ROOTS) {
    try {
      await readdir(root);
      return root;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

export async function seedSkills(): Promise<void> {
  const root = await resolveSkillsRoot();
  if (root === null) {
    // Loud rather than silent: an image that shipped without the directory has
    // no built-in skills at all, and the symptom otherwise is an empty
    // catalogue that looks like a product decision.
    throw new Error(`No built-in skills directory found. Looked in: ${CANDIDATE_ROOTS.join(', ')}`);
  }

  const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const directory of directories) {
    const files = await readSkillDirectory(join(root, directory.name));
    const bundle = buildSkillBundle(files, { directoryName: directory.name });
    const metadata = bundle.document.frontmatter.metadata;

    const result = await storeSkillBundle(getDb(), bundle, {
      source: 'builtin',
      ownerOxyUserId: null,
      visibility: 'public',
      publisher: 'Alia',
      icon: metadata.icon ?? null,
      color: metadata.color ?? null,
    });

    if (result.unchanged) unchanged += 1;
    else if (result.createdSkill) created += 1;
    else updated += 1;

    for (const warning of bundle.warnings) {
      log.general.warn({ skill: directory.name, warning }, 'Built-in skill warning');
    }
  }

  log.general.info({ created, updated, unchanged, root }, 'Seeded built-in skills');
}
