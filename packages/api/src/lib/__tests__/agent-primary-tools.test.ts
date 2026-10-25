/**
 * An agent's primary tools resolve to the names THIS turn bound them under —
 * the person's lane first, the agent's own account only where that is all
 * there is — and a save names only tools a live catalogue offers agents.
 */
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  catalogs: [] as unknown[],
}));

vi.mock('../tools/oxy-services.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/oxy-services.js')>()),
  listOxyAppCatalogs: async () => H.catalogs,
}));
const { listPrimaryToolOptions, primaryToolNames, refusePrimaryTools } = await import(
  '../agent-primary-tools.js'
);

function catalogTool(name: string, effect: 'read' | 'write', exposure = ['internal']) {
  return {
    name,
    description: `${name} tool`,
    capabilityPackage: effect === 'read' ? 'read' : 'create',
    resourceTypes: ['homiio_account'],
    effect,
    exposure,
  };
}

const HOMIIO = {
  appId: 'homiio',
  accountResourceType: 'homiio_account',
  tools: [
    catalogTool('searchListings', 'read'),
    catalogTool('saveHome', 'write'),
    catalogTool('publicOnly', 'read', ['public']),
  ],
};

const noop = tool({ inputSchema: z.object({}), execute: async () => ({}) });
const toolSet = (...names: string[]): ToolSet =>
  Object.fromEntries(names.map((name) => [name, noop]));

beforeEach(() => {
  H.catalogs = [HOMIIO];
});

describe('primaryToolNames', () => {
  it("names the person's lane where the turn bound the tool there, every resource of it", () => {
    const tools = toolSet(
      'oxy_homiio__searchListings',
      'oxy_homiio__saveHome__acct2',
      'oxy_homiio__saveHome__acct1',
      'self_homiio__searchListings',
      'webSearch',
    );
    expect(primaryToolNames(['homiio:searchListings', 'homiio:saveHome'], tools)).toEqual([
      'oxy_homiio__searchListings',
      'oxy_homiio__saveHome__acct2',
      'oxy_homiio__saveHome__acct1',
    ]);
  });

  it("falls back to the agent's own account only where that is the lane", () => {
    expect(
      primaryToolNames(['homiio:searchListings'], toolSet('self_homiio__searchListings')),
    ).toEqual(['self_homiio__searchListings']);
  });

  it('stands for nothing when no lane binds the tool, and never for a near name', () => {
    const tools = toolSet('oxy_homiio__searchListingsByAgent', 'oxy_mention__searchListings');
    expect(primaryToolNames(['homiio:searchListings', 'not a key'], tools)).toEqual([]);
  });
});

describe('refusePrimaryTools', () => {
  it('accepts tools a live catalogue offers agents', async () => {
    expect(await refusePrimaryTools(['homiio:searchListings', 'homiio:saveHome'])).toBeNull();
  });

  it('refuses a malformed key, a repeat, an unknown tool and a tool agents cannot use', async () => {
    expect(await refusePrimaryTools(['searchListings'])).toMatch(/not an <app>:<tool> key/);
    expect(await refusePrimaryTools(['homiio:saveHome', 'homiio:saveHome'])).toMatch(/twice/);
    expect(await refusePrimaryTools(['homiio:nothing'])).toMatch(/offers no tool/);
    expect(await refusePrimaryTools(['inbox:searchListings'])).toMatch(/offers no tool/);
    expect(await refusePrimaryTools(['homiio:publicOnly'])).toMatch(/not a tool an agent/);
  });
});

describe('listPrimaryToolOptions', () => {
  it('offers every internal agent tool without per-app grants or ceilings', async () => {
    const [app] = await listPrimaryToolOptions();
    expect(app?.tools.map((entry) => entry.key)).toEqual([
      'homiio:searchListings',
      'homiio:saveHome',
    ]);
  });
  it('omits apps with no internal tools', async () => {
    H.catalogs = [{ ...HOMIIO, tools: [catalogTool('publicOnly', 'read', ['public'])] }];
    expect(await listPrimaryToolOptions()).toEqual([]);
  });
});
