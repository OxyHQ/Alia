import { createRef, forwardRef, useImperativeHandle } from 'react';
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
  resumed: [] as Array<{ agent: unknown; conversationId: string }>,
  dismissed: 0,
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ canUsePrivateApi: world.canUsePrivateApi, signIn: world.signIn }),
}));
vi.mock('../../src/components/AliaChatSheet', () => ({
  AliaChatSheet: forwardRef(function Sheet(props: Record<string, unknown>, ref) {
    world.sheets.push(props);
    useImperativeHandle(ref, () => ({
      present: (turn?: unknown) => world.presented.push({ agent: props.agent, turn }),
      resume: (conversationId: string) =>
        world.resumed.push({ agent: props.agent, conversationId }),
      dismiss: () => {
        world.dismissed += 1;
      },
    }));
    return null;
  }),
}));

import { AliaAskProvider, type AliaAsk, useAskAgent } from '../../src/components/AliaAskProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Runs `step` and lets the lazily loaded sheet arrive and present what it was handed. */
async function settle(step: () => void = () => undefined) {
  await act(async () => {
    step();
    await import('../../src/components/AliaAskSheet');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let ask: AliaAsk;
function Button() {
  ask = useAskAgent();
  return null;
}

const hostTools = {
  definitions: [],
  execute: async () => ({ outcome: 'applied' as const }),
};
const onFeatureLocked = vi.fn();
let renderer: ReactTestRenderer | null = null;
const providerRef = createRef<AliaAsk>();
async function mount() {
  await act(async () => {
    renderer = create(
      <AliaAskProvider
        ref={providerRef}
        agents={{ alia: {}, sindi: { id: 'agent-sindi' } }}
        app="homiio"
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
  world.resumed = [];
  world.dismissed = 0;
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('AliaAskProvider', () => {
  it('signed out, mounts no sheet and asks Oxy to sign the person in', async () => {
    await mount();
    await settle(() => ask.ask('sindi'));

    expect(world.signIn).toHaveBeenCalledTimes(1);
    expect(world.sheets).toEqual([]);
    expect(world.presented).toEqual([]);
  });

  it('signed in, opens the one sheet on the agent asked for, with the turn and the app’s setup', async () => {
    world.canUsePrivateApi = true;
    await mount();
    await settle(() => ask.ask('sindi', { text: 'Is this flat a good price?' }));

    expect(world.signIn).not.toHaveBeenCalled();
    expect(world.presented).toEqual([
      { agent: { id: 'agent-sindi' }, turn: { text: 'Is this flat a good price?' } },
    ]);
    const sheet = world.sheets.at(-1);
    expect(sheet).toMatchObject({
      agent: { id: 'agent-sindi' },
      app: 'homiio',
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
    await settle(() => ask.ask('alia'));
    await settle(() => ask.ask());

    expect(world.presented.map((p) => p.agent)).toEqual([undefined, undefined]);
    expect(world.sheets.at(-1)?.welcomeSuggestions).toEqual([{ id: 's', text: 'Find a flat' }]);
  });

  it('signed in, mounts nothing until the first ask, so the chat arrives with it', async () => {
    world.canUsePrivateApi = true;
    await mount();
    await settle();
    expect(world.sheets).toEqual([]);

    await settle(() => ask.ask());
    expect(world.sheets.length).toBeGreaterThan(0);
    expect(world.presented).toEqual([{ agent: undefined, turn: undefined }]);
  });

  it('refuses a key it was not given', async () => {
    world.canUsePrivateApi = true;
    await mount();
    expect(() => ask.ask('nobody')).toThrow(/no agent "nobody"/);
  });

  it('picks a stored conversation up again in the sheet of its agent', async () => {
    world.canUsePrivateApi = true;
    await mount();
    await settle(() => ask.resume('sindi', 'conv-7'));

    expect(world.resumed).toEqual([{ agent: { id: 'agent-sindi' }, conversationId: 'conv-7' }]);
    expect(world.presented).toEqual([]);
  });

  it('closes the sheet, through the hook and through the ref the code above it holds', async () => {
    world.canUsePrivateApi = true;
    await mount();
    await settle(() => ask.ask('sindi'));
    await settle(() => ask.dismiss());
    await settle(() => providerRef.current?.dismiss());

    expect(world.dismissed).toBe(2);
  });
});
