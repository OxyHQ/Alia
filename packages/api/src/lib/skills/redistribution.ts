/**
 * May Alia HOST a copy of this skill?
 *
 * The shared catalogue is redistribution: Alia stores somebody else's files and
 * serves them to every account. That is a licence question, and it has a wrong
 * answer that costs nothing to reach — `anthropics/skills` is mostly Apache-2.0
 * and its four document skills are not:
 *
 *     skills/algorithmic-art/LICENSE.txt  →  Apache License, Version 2.0
 *     skills/docx/LICENSE.txt             →  © 2025 Anthropic, PBC.
 *                                            All rights reserved.
 *
 * Both sit in one repository, under one path, with frontmatter that says the
 * same thing about each: `license: Complete terms in LICENSE.txt`. So a sync
 * that trusts the repository, or the frontmatter, or a hardcoded list of four
 * names that rots the moment upstream adds a fifth, gets this wrong silently.
 *
 * What this does instead is read the licence the bundle actually carries and
 * ask whether it is one of the permissive families. A skill with no licence at
 * all is refused too: no licence means default copyright, which is the same
 * answer as "all rights reserved" with less text.
 *
 * This gates the CATALOGUE only. A person importing a skill into their own
 * account is not redistribution — that is the same act as cloning the
 * repository, and it stays their call.
 */

import type { SkillBundle } from './bundle.js';

/**
 * The families that permit redistribution with attribution.
 *
 * Matched against the licence TEXT, not a filename: a file called `LICENSE.txt`
 * says nothing until it is read, which is exactly the trap above.
 */
const PERMISSIVE = [
  { name: 'Apache-2.0', pattern: /apache license,?\s+version 2\.0/i },
  { name: 'MIT', pattern: /\bMIT License\b/i },
  { name: 'BSD-3-Clause', pattern: /redistribution and use in source and binary forms/i },
  { name: 'ISC', pattern: /\bISC License\b/i },
  { name: 'MPL-2.0', pattern: /mozilla public license version 2\.0/i },
  { name: 'CC0-1.0', pattern: /\bCC0 1\.0\b/i },
  { name: 'CC-BY-4.0', pattern: /creative commons attribution 4\.0/i },
  { name: 'Unlicense', pattern: /this is free and unencumbered software released into the public domain/i },
] as const;

/** A short licence identifier in frontmatter is evidence on its own. */
const SPDX = /^(apache-2\.0|mit|bsd-2-clause|bsd-3-clause|isc|mpl-2\.0|cc0-1\.0|cc-by-4\.0|unlicense)$/i;

/** Filenames that conventionally hold the terms. */
const LICENCE_FILE = /^(licen[cs]e|copying)(\.[a-z]+)?$/i;

export interface RedistributionVerdict {
  readonly permitted: boolean;
  /** The licence as identified, or as the bundle declared it when unrecognised. */
  readonly license: string;
  /** Where the answer came from, so a refusal can be explained to whoever asks. */
  readonly evidence: string;
}

export function classifyRedistribution(bundle: SkillBundle): RedistributionVerdict {
  const declared = bundle.document.frontmatter.license?.trim() ?? '';

  if (declared && SPDX.test(declared)) {
    return { permitted: true, license: declared, evidence: 'the SKILL.md `license` field' };
  }

  const licenceFile = bundle.files.find((file) => LICENCE_FILE.test(file.path.split('/').pop() ?? ''));
  if (licenceFile?.contentText) {
    const match = PERMISSIVE.find((entry) => entry.pattern.test(licenceFile.contentText!));
    if (match) {
      return { permitted: true, license: match.name, evidence: `${licenceFile.path} in the bundle` };
    }
    return {
      permitted: false,
      license: declared || 'unrecognised',
      evidence: `${licenceFile.path} is not a licence that permits redistribution`,
    };
  }

  // The frontmatter may also carry the full name of a permissive licence rather
  // than its identifier — `license: Apache License 2.0` is common.
  const named = declared ? PERMISSIVE.find((entry) => entry.pattern.test(declared)) : undefined;
  if (named) return { permitted: true, license: named.name, evidence: 'the SKILL.md `license` field' };

  return {
    permitted: false,
    license: declared || 'none',
    evidence: declared
      ? 'the declared licence is not a recognised permissive one, and the bundle carries no licence file'
      : 'the skill declares no licence, which means default copyright',
  };
}
