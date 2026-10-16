import { forwardRef, useImperativeHandle } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One sheet an app mounts once and opens on any agent: signed out, `ask` is Oxy's sign-in; signed
 * in, it opens the sheet on the agent asked for, with the app's configuration, and the turn.
 */

const world = vi.hoisted(() => ({
  canUsePrivateApi: false,
  signIn: vi.fn(async () => ({ status: 'dialog-opened' as const })),
  sheets: [] as Array<Record<string, unknown>>,
  presented: [] as Array<{ agent: unknown; turn: unknown }>,
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ canUsePrivateApi: world.canUsePrivateApi, signIn: world.signIn }),
}));
vi.mock('../../src/components/AliaChatSheet', () => ({
  AliaChatSheet: forwardRef(function Sheet(props: Record<string, unknown>, ref) {
    world.sheets.push(props);
    useImperativeHandle(ref, () => ({
      present: (turn?: unknown) => world.presented.push({ agent: props.agent, turn }),
      dismiss: () => {},
    }));
    return null;
  }),
}));

import { AliaAskProvider, type AliaAsk, useAskAgent } from '../../src/components/AliaAskProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let ask: AliaAsk;
function Button() {
  ask = useAskAgent();
  return null;
}

const hostTools = {
  app: 'homiio',
  definitions: [],
  execute: async () => ({ outcome: 'applied' as const }),
};
const onFeatureLocked = vi.fn();
let renderer: ReactTestRenderer | null = null;
async function mount() {
  await act(async () => {
    renderer = create(
      <AliaAskProvider
        agents={{ alia: {}, sindi: { id: 'agent-sindi' } }}
        hostTools={hostTools}
        clientContext="Homiio — viewing listing 7"
        onFeatureLocked={onFeatureLocked}
        welcomeSuggestions={[{ id: 's', text: 'Find a flat' }]}
      >
        <Button />
      </AliaAskProvider>,
    );
  });
}

beforeEach(() => {
  world.canUsePrivateApi = false;
  world.signIn.mockClear();
  world.sheets = [];
  world.presented = [];
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('AliaAskProvider', () => {
  it('signed out, mounts no sheet and asks Oxy to sign the person in', async () => {
    await mount();
    await act(async () => ask.ask('sindi'));

    expect(world.signIn).toHaveBeenCalledTimes(1);
    expect(world.sheets).toEqual([]);
    expect(world.presented).toEqual([]);
  });

  it('signed in, opens the one sheet on the agent asked for, with the turn and the app’s setup', async () => {
    world.canUsePrivateApi = true;
    await mount();
    await act(async () => ask.ask('sindi', { text: 'Is this flat a good price?' }));

    expect(world.signIn).not.toHaveBeenCalled();
    expect(world.presented).toEqual([
      { agent: { id: 'agent-sindi' }, turn: { text: 'Is this flat a good price?' } },
    ]);
    const sheet = world.sheets.at(-1);
    expect(sheet).toMatchObject({
      agent: { id: 'agent-sindi' },
      hostTools,
      clientContext: 'Homiio — viewing listing 7',
      onFeatureLocked,
    });
    // An agent greets with its own starters, not the app's suggestions for Alia.
    expect(sheet?.welcomeSuggestions).toBeUndefined();
  });

  it('opens on Alia for an entry without an id, or no key at all', async () => {
    world.canUsePrivateApi = true;
    await mount();
    await act(async () => ask.ask('alia'));
    await act(async () => ask.ask());

    expect(world.presented.map((p) => p.agent)).toEqual([undefined, undefined]);
    expect(world.sheets.at(-1)?.welcomeSuggestions).toEqual([{ id: 's', text: 'Find a flat' }]);
  });

  it('refuses a key it was not given', async () => {
    world.canUsePrivateApi = true;
    await mount();
    expect(() => ask.ask('nobody')).toThrow(/no agent "nobody"/);
  });
});
