import { describe, expect, it } from 'vitest';

/**
 * May Alia host a copy of this skill?
 *
 * The fixtures are the real thing: `anthropics/skills` ships Apache-2.0 skills
 * and all-rights-reserved ones under one path, with frontmatter that says the
 * same about each (`license: Complete terms in LICENSE.txt`). If this file's
 * cases look oddly specific, that is why — they were read out of the repository
 * the catalogue actually syncs.
 */

import { classifyRedistribution } from '../redistribution.js';

function bundle(license: string | null, files: { path: string; contentText?: string }[] = []) {
  return {
    document: { frontmatter: { name: 'x', description: 'd', license, compatibility: null, metadata: {}, allowedTools: [] }, body: '', raw: {}, warnings: [] },
    directoryName: 'x',
    files: files.map((file) => ({ ...file, kind: 'asset' as const, mime: 'text/plain', bytes: 1, sha256: 'a', executable: false })),
    bytes: 1,
    checksum: 'c',
    warnings: [],
  };
}

const APACHE = 'Apache License\n                           Version 2.0, January 2004';
const RESERVED = '© 2025 Anthropic, PBC. All rights reserved.\n\nLICENSE: Use of these materials is governed by your agreement with Anthropic.';

describe('permitted', () => {
  it('accepts an SPDX identifier in the frontmatter', () => {
    expect(classifyRedistribution(bundle('Apache-2.0') as never)).toMatchObject({ permitted: true, license: 'Apache-2.0' });
    expect(classifyRedistribution(bundle('MIT') as never).permitted).toBe(true);
  });

  it('reads the bundled licence when the frontmatter only points at it', () => {
    const verdict = classifyRedistribution(
      bundle('Complete terms in LICENSE.txt', [{ path: 'LICENSE.txt', contentText: APACHE }]) as never,
    );
    expect(verdict).toMatchObject({ permitted: true, license: 'Apache-2.0' });
    expect(verdict.evidence).toContain('LICENSE.txt');
  });

  it('accepts a licence named in full rather than by identifier', () => {
    expect(classifyRedistribution(bundle('Apache License, Version 2.0') as never).permitted).toBe(true);
  });
});

describe('refused', () => {
  /**
   * The case the whole module exists for. Same repository, same path, same
   * frontmatter shape as the Apache-2.0 skill above — and not redistributable.
   */
  it('refuses an all-rights-reserved skill whose frontmatter looks identical to a permissive one', () => {
    const verdict = classifyRedistribution(
      bundle('Proprietary. LICENSE.txt has complete terms', [{ path: 'LICENSE.txt', contentText: RESERVED }]) as never,
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.evidence).toContain('LICENSE.txt');
  });

  it('refuses a skill with no licence, because that means default copyright', () => {
    expect(classifyRedistribution(bundle(null) as never)).toMatchObject({ permitted: false, license: 'none' });
  });

  it('refuses a licence file it cannot read as text', () => {
    expect(
      classifyRedistribution(bundle('see LICENSE', [{ path: 'LICENSE' }]) as never).permitted,
    ).toBe(false);
  });

  it('refuses an unrecognised licence rather than guessing', () => {
    expect(classifyRedistribution(bundle('Internal use only') as never).permitted).toBe(false);
  });
});
