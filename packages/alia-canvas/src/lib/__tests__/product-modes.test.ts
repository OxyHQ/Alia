import { describe, expect, it } from 'vitest';

import {
  AUTOMATIC,
  labelForNode,
  offeredModes,
  parseCatalogue,
  parseModes,
} from '../product-modes';

/**
 * `alia-canvas`'s first test.
 *
 * ## Why this package and why this module
 *
 * The package had no `test` script and no suite: 4,041 lines with a `tsc -b`
 * and a wrangler dry-run between them and nothing else. `product-modes.ts` is
 * the part worth starting with, because it is where this app decides what a
 * person is OFFERED and what identifier a node then stores — and its own header
 * records that the file it replaced showed a hardcoded alias name under a label
 * reading "Model", for every node, for as long as the editor existed.
 *
 * That is the class of defect these cases are aimed at. Two rules from #139 are
 * not style preferences here, they are the product boundary:
 *
 *  * a person is offered PRODUCT MODES, never a raw identifier, and
 *  * a node stores the `profile:*` identifier the catalogue publishes, or
 *    nothing at all for Automatic — never a `mode:*` id, which no request path
 *    consumes.
 *
 * ## Why the parsers are tested against malformed payloads
 *
 * Both parse a response from a server this app does not deploy with. The
 * failure they must not have is the quiet one: a shape they half-understand,
 * turned into a picker with a plausible wrong entry in it. Throwing is the
 * designed answer, and the caller renders Automatic alone.
 */

const catalogueBody = (data: unknown) => ({ object: 'list', data });

const entry = (over: Record<string, unknown> = {}) => ({
  object: 'routing_profile',
  id: 'profile:balanced',
  display_name: 'Balanced',
  description: 'a sensible default',
  chat_visible: true,
  ...over,
});

const mode = (over: Record<string, unknown> = {}) => ({
  object: 'product_mode',
  id: 'mode:balanced',
  label: 'Balanced',
  description: 'a sensible default',
  routing: { kind: 'profile', profile_id: 'profile:balanced' },
  ...over,
});

describe('parseCatalogue', () => {
  it('reads the entries a catalogue response carries', () => {
    const entries = parseCatalogue(catalogueBody([entry(), entry({ id: 'profile:fast', display_name: 'Fast' })]));
    expect(entries.map((e) => e.id)).toEqual(['profile:balanced', 'profile:fast']);
    expect(entries[0].chatVisible).toBe(true);
  });

  it('skips a row that is not a model or a routing profile', () => {
    const entries = parseCatalogue(catalogueBody([entry(), entry({ object: 'something_else', id: 'x' })]));
    expect(entries.map((e) => e.id)).toEqual(['profile:balanced']);
  });

  it('skips a row missing the two fields a picker cannot do without', () => {
    const entries = parseCatalogue(
      catalogueBody([entry({ id: undefined }), entry({ display_name: undefined }), entry()]),
    );
    expect(entries).toHaveLength(1);
  });

  it('treats chat_visible as strictly boolean true', () => {
    // A truthy string from a server that changed its serialisation must not
    // put a hidden profile in front of a person.
    const entries = parseCatalogue(
      catalogueBody([entry({ chat_visible: 'yes' }), entry({ id: 'profile:b', chat_visible: 1 })]),
    );
    expect(entries.every((e) => e.chatVisible === false)).toBe(true);
  });

  it('THROWS on a response it cannot read at all', () => {
    // Rather than answering an empty list, which is indistinguishable from "the
    // catalogue is empty" and would silently offer nothing.
    for (const bad of [null, undefined, 42, 'nope', {}, { data: null }, { data: 'list' }]) {
      expect(() => parseCatalogue(bad), JSON.stringify(bad)).toThrow(/could not be read/);
    }
  });

  it('THROWS when rows arrived but none of them parsed', () => {
    // The dangerous case: the server answered, the shape changed wholesale, and
    // an empty result would read as "nothing is available today".
    expect(() => parseCatalogue(catalogueBody([{ nope: true }, { also: 'nope' }]))).toThrow(
      /could not be read/,
    );
  });

  it('accepts a genuinely empty catalogue', () => {
    expect(parseCatalogue(catalogueBody([]))).toEqual([]);
  });
});

describe('parseModes', () => {
  it('reads a mode and its routing', () => {
    const [parsed] = parseModes(catalogueBody([mode()]));
    expect(parsed.id).toBe('mode:balanced');
    expect(parsed.routing).toEqual({ kind: 'profile', profileId: 'profile:balanced' });
  });

  it('REFUSES a mode whose routing is not a usable profile identifier', () => {
    /**
     * Strict rather than lenient, and deliberately so: a mode is only a label
     * for a profile, so a mode whose profile cannot be read is a picker entry
     * that would send nothing. An id that is empty, padded, or of another kind
     * cannot be sent, and half-reading one is worse than refusing the response.
     */
    for (const routing of [
      { kind: 'profile', profile_id: '' },
      { kind: 'profile', profile_id: '  profile:x  ' },
      { kind: 'something-else', profile_id: 'profile:x' },
      { kind: 'profile' },
      null,
    ]) {
      expect(() => parseModes(catalogueBody([mode({ routing })])), JSON.stringify(routing)).toThrow(
        /could not be read/,
      );
    }
  });

  it('REFUSES a mode whose id is not a `mode:` identifier, or whose label is missing', () => {
    for (const over of [{ id: 'profile:balanced' }, { id: '' }, { id: ' mode:x ' }, { label: '' }, { label: undefined }]) {
      expect(() => parseModes(catalogueBody([mode(over)])), JSON.stringify(over)).toThrow(
        /could not be read/,
      );
    }
  });

  it('THROWS on a response it cannot read', () => {
    expect(() => parseModes(null)).toThrow();
    expect(() => parseModes({ data: 'not a list' })).toThrow();
  });
});

describe('offeredModes', () => {
  // Automatic carries a routing like any other mode — `parseModes` refuses one
  // without it. What makes it Automatic is that `offeredModes` gives it the
  // sentinel id rather than its profile.
  const modes = [
    mode({
      id: 'mode:automatic',
      label: 'Automatic',
      description: 'let Alia choose',
      routing: { kind: 'profile', profile_id: 'profile:balanced' },
    }),
    mode(),
  ];
  const parsed = parseModes(catalogueBody(modes));

  it('puts Automatic first, and offers only chat-visible entries', () => {
    const entries = parseCatalogue(
      catalogueBody([entry(), entry({ id: 'profile:hidden', display_name: 'Hidden', chat_visible: false })]),
    );

    const offered = offeredModes(entries, parsed);
    expect(offered[0].id).toBe(AUTOMATIC);
    expect(offered.map((o) => o.id)).not.toContain('profile:hidden');
  });

  it('offers no Automatic row when the server publishes no automatic mode', () => {
    const entries = parseCatalogue(catalogueBody([entry()]));
    const offered = offeredModes(entries, parseModes(catalogueBody([mode()])));
    expect(offered.map((o) => o.id)).toEqual(['profile:balanced']);
  });

  it('never offers a `mode:*` id as something a node could store', () => {
    /**
     * #139: a mode is a LABEL for a profile, not a selectable identifier —
     * nothing in the request path consumes a `mode:*` id. What a node stores is
     * either a `profile:*` identifier or the Automatic sentinel, and this is
     * the assertion that keeps a future edit from putting a mode id in the
     * picker's value.
     */
    const entries = parseCatalogue(catalogueBody([entry(), entry({ id: 'profile:fast', display_name: 'Fast' })]));
    for (const row of offeredModes(entries, parsed)) {
      expect(row.id.startsWith('mode:'), row.id).toBe(false);
      expect(row.id === AUTOMATIC || row.id.startsWith('profile:'), row.id).toBe(true);
    }
  });

  it('offers nothing at all when the catalogue is empty and there is no automatic mode', () => {
    expect(offeredModes([], [])).toEqual([]);
  });
});

describe('labelForNode', () => {
  const offered = [
    { id: AUTOMATIC, label: 'Automatic', description: 'let Alia choose' },
    { id: 'profile:balanced', label: 'Balanced', description: 'a sensible default' },
  ];

  it('labels a node that stores a profile', () => {
    expect(labelForNode('profile:balanced', offered)).toBe('Balanced');
  });

  it('reads a node with NO model as Automatic', () => {
    // Automatic is the absence of a `model` field, not a value; both forms of
    // absence have to land on the same label.
    expect(labelForNode(undefined, offered)).toBe('Automatic');
    expect(labelForNode('', offered)).toBe('Automatic');
  });

  it('answers null rather than showing an identifier it cannot name', () => {
    // The product rule: a person is never shown a raw identifier. `null` lets
    // the caller render its own placeholder.
    expect(labelForNode('profile:retired', offered)).toBeNull();
    expect(labelForNode('profile:balanced', undefined)).toBeNull();
  });
});
