/**
 * The platform-capability filter (#139 workstream 5).
 *
 * ## Two censuses, each with the thing that would make it vacuous named
 *
 * **Surfaces.** A list of names is contradicted by nothing, so every surface is
 * asserted to be a real workspace directory under `packages/`. The floor is the
 * directory listing itself: if `readdirSync` returned nothing, every membership
 * test would fail rather than pass, which is the correct direction for a broken
 * scan.
 *
 * **Categories.** `CATEGORY_REQUIREMENTS` is asserted equal to the category
 * vocabulary the ALIAS SET actually uses, in both directions. A subset check
 * would let a new category arrive unmapped, and `surfaceCanOffer` treats an
 * unmapped category as offerable — so the gap would show up as entries reaching
 * a surface that cannot render them, silently. This is the one file allowed to
 * import `internal/providers/lib/alia-models` for that comparison, recorded in
 * gate 1's allowlist.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALIA_MODELS } from '../../internal/providers/lib/alia-models.js';
import {
  CATEGORY_REQUIREMENTS,
  SURFACES,
  SURFACE_CAPABILITIES,
  SURFACE_MODALITIES,
  getSurface,
  surfaceCanOffer,
} from '../surface-capability.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

describe('every surface names a workspace that exists', () => {
  it('is anchored to the package listing, not to a set of names', () => {
    const packages = readdirSync(path.join(REPO_ROOT, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // The floor and the positive control in one: the scan found a real tree,
    // and it can see a workspace that is deliberately NOT a surface — `api` is
    // this server, so its absence below is a decision rather than a miss.
    expect(packages.length).toBeGreaterThanOrEqual(8);
    expect(packages).toContain('api');
    expect(SURFACES).not.toContain('api');

    for (const [name, capability] of Object.entries(SURFACE_CAPABILITIES)) {
      expect(
        existsSync(path.join(REPO_ROOT, capability.workspace)),
        `surface ${name} names a workspace that is gone: ${capability.workspace}`,
      ).toBe(true);
      // Under `packages/`, so a surface cannot be anchored to any path that
      // happens to exist. The control below proves the check can say no.
      expect(packages).toContain(path.basename(capability.workspace));
    }
    expect(existsSync(path.join(REPO_ROOT, 'packages/not-a-workspace'))).toBe(false);
    // No two surfaces are the same client under different names.
    const workspaces = Object.values(SURFACE_CAPABILITIES).map((c) => c.workspace);
    expect(new Set(workspaces).size).toBe(workspaces.length);
  });

  it('gives every surface text and a modality vocabulary it stays inside', () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(7);
    for (const name of SURFACES) {
      const capability = SURFACE_CAPABILITIES[name];
      // A surface that cannot render text is not a chat client, and admitting
      // one would make the filter meaningless: every entry answers in text.
      expect(capability.modalities, `${name} cannot render text`).toContain('text');
      for (const modality of capability.modalities) {
        expect(SURFACE_MODALITIES, `${name} declares an unknown modality`).toContain(modality);
      }
    }
  });

  it('resolves a declared name and refuses one it does not know', () => {
    expect(getSurface('terminal')).toEqual({
      name: 'terminal',
      workspace: 'packages/alia-codea-cli',
      modalities: ['text'],
    });
    expect(getSurface('telepathy')).toBeNull();
    // A prototype-borrowed key is not a surface. Without this, `?surface=
    // constructor` would resolve to a function and the filter would run over it.
    expect(getSurface('constructor')).toBeNull();
    expect(getSurface('toString')).toBeNull();
  });
});

describe('every category the alias set uses has a requirement', () => {
  it('maps exactly the categories in use, in both directions', () => {
    const inUse = [...new Set(Object.values(ALIA_MODELS).map((m) => m.category))].sort();

    // The floor before the equality: the alias set was read and is not empty.
    expect(Object.keys(ALIA_MODELS).length).toBeGreaterThanOrEqual(12);
    expect(inUse.length).toBeGreaterThanOrEqual(5);

    // Exact, not a subset. A category with no entry here is OFFERED to every
    // surface by `surfaceCanOffer`, so an unmapped one is an entry reaching a
    // client that cannot render it — which fails as a bug report, never as a
    // test. This equality is what turns it into a test failure instead.
    expect(Object.keys(CATEGORY_REQUIREMENTS).sort()).toEqual(inUse);

    for (const required of Object.values(CATEGORY_REQUIREMENTS)) {
      expect(required.length).toBeGreaterThan(0);
      for (const modality of required) expect(SURFACE_MODALITIES).toContain(modality);
    }
  });

  it('withholds an entry whose modality the surface does not carry, and only then', () => {
    const terminal = getSurface('terminal');
    const chat = getSurface('chat');
    const canvas = getSurface('canvas');
    if (terminal === null || chat === null || canvas === null) throw new Error('unreachable');

    // The property the checkbox asks for, at the function.
    expect(surfaceCanOffer(terminal, 'voice')).toBe(false);
    expect(surfaceCanOffer(terminal, 'audio')).toBe(false);
    expect(surfaceCanOffer(terminal, 'vision')).toBe(false);
    // …and its negative half, so "withholds everything" cannot pass for it.
    expect(surfaceCanOffer(terminal, 'general')).toBe(true);
    expect(surfaceCanOffer(terminal, 'coding')).toBe(true);

    // A surface carrying every modality withholds nothing.
    for (const category of Object.keys(CATEGORY_REQUIREMENTS)) {
      expect(surfaceCanOffer(chat, category), `chat cannot offer ${category}`).toBe(true);
    }

    // And a partial one is partial: canvas takes images but not audio, so
    // `multimodal` — which needs both — is withheld while `vision` is not.
    expect(surfaceCanOffer(canvas, 'vision')).toBe(true);
    expect(surfaceCanOffer(canvas, 'multimodal')).toBe(false);
  });
});
