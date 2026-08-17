import { describe, expect, it } from 'vitest';

import router from '../catalogue.js';
import { PRODUCT_MODES } from '../../lib/product-modes.js';
import { ROUTING_PRESETS } from '../../lib/routing/presets.js';

/**
 * `GET /catalogue/modes` — the wire shape of a product mode (#139 workstream 4).
 *
 * Gate 5 of `__tests__/architectureGates.test.ts` owns the invariant that
 * nothing here is serialized `object: "model"`. This file owns the rest of the
 * payload: field names, the routing discriminant, and the fact that a mode
 * carries no capability, price, entitlement or provider detail — a mode is a
 * product decision, and anything else on it would be a claim about something
 * else.
 *
 * The REAL handler runs. It reads only a module constant, so unlike the
 * catalogue itself it needs no data stand-ins at all.
 */

interface Captured {
  status?: number;
  body?: { object?: string; data?: Record<string, unknown>[] };
}

/** Express does not type its own layer stack; this is the shape it has. */
interface RouterLike {
  stack: {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: { handle: (req: unknown, res: unknown) => void }[];
    };
  }[];
}

function runModes(): Captured {
  const { stack } = router as unknown as RouterLike;
  const layer = stack.find((l) => l.route?.path === '/modes' && l.route.methods.get);
  expect(layer?.route).toBeDefined();
  const handle = layer?.route?.stack[layer.route.stack.length - 1].handle;
  expect(handle).toBeTypeOf('function');

  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Captured['body']) {
      captured.body = body;
      return res;
    },
  };
  handle?.({ query: {} }, res);
  return captured;
}

describe('the modes surface serves the product table, in the product vocabulary', () => {
  it('answers a list of every mode, unauthenticated', () => {
    const captured = runModes();
    expect(captured.status).toBeUndefined();
    expect(captured.body?.object).toBe('list');
    expect(captured.body?.data).toHaveLength(PRODUCT_MODES.length);
    expect(captured.body?.data?.map((entry) => entry.id)).toEqual(PRODUCT_MODES.map((m) => m.id));
  });

  it('names its fields in the convention this API already uses', () => {
    const entry = runModes().body?.data?.[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'deep_research',
      'description',
      'id',
      'label',
      'object',
      'routing',
    ]);
  });

  it('publishes the routing discriminant rather than flattening it to a profile', () => {
    // The two `default` modes pin no profile. Resolving them here to whichever
    // profile the product default happens to be would publish a routing claim
    // the product does not make, and would silently change meaning the day the
    // default moves.
    const byId = new Map((runModes().body?.data ?? []).map((entry) => [entry.id as string, entry]));

    expect(byId.get('mode:automatic')?.routing).toEqual({ kind: 'default' });
    expect(byId.get('mode:deep-research')?.routing).toEqual({ kind: 'default' });
    expect(byId.get('mode:deep-research')?.deep_research).toBe(true);

    const profiles = new Set(ROUTING_PRESETS.map((preset) => preset.id));
    for (const mode of PRODUCT_MODES) {
      if (mode.routing.kind !== 'profile') continue;
      const routing = byId.get(mode.id)?.routing as { kind: string; profile_id: string };
      expect(routing.kind).toBe('profile');
      expect(routing.profile_id).toBe(mode.routing.profile);
      // A profile id a client cannot resolve is worse than none.
      expect(profiles).toContain(routing.profile_id);
    }
    // Floor: at least one entry took the branch above.
    expect(PRODUCT_MODES.filter((m) => m.routing.kind === 'profile').length).toBeGreaterThanOrEqual(4);
  });

  it('says nothing about capability, price, entitlement or where a request goes', () => {
    // A mode is a product decision. Capability and entitlement belong to the
    // entries it routes through and are annotated on `GET /catalogue`; a
    // provider or upstream model id would breach the model-abstraction rule
    // outright.
    const serialized = JSON.stringify(runModes().body).toLowerCase();
    for (const forbidden of ['capabilit', 'pricing', 'credit', 'entitle', 'provider', 'owned_by']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    // The scan's positive control: it can see one of those words when present.
    expect(JSON.stringify({ planted: 'provider' }).toLowerCase()).toContain('provider');
  });
});
