import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The space dialog: what each mode asks, when it lets the person submit, the six-agent bound and
 * the strict body it hands back. Bloom's dialog and fields are host-element stand-ins.
 */

const world = vi.hoisted(() => ({ toast: { error: vi.fn() } }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/shared/platform/use-keyboard-on-open', () => ({ useKeyboardOnOpen: () => undefined }));
vi.mock('@alia.onl/sdk', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('@oxy.so/bloom/agent-avatar', () => ({ AgentAvatar: () => null }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: world.toast }));
vi.mock('@/features/spaces/runtime/use-spaces', () => ({
  spaceErrorCode: (error: { code?: string }) => error?.code,
}));
vi.mock('@oxy.so/bloom/dialog', async () => {
  const ReactModule = await import('react');
  return {
    Dialog: ({
      open,
      title,
      actions,
      children,
    }: React.PropsWithChildren<{ open: boolean; title: string; actions: any[] }>) =>
      open
        ? ReactModule.createElement(
            'Dialog',
            { title },
            children,
            actions.map((action) =>
              ReactModule.createElement('DialogAction', { key: action.label, ...action }),
            ),
          )
        : null,
  };
});
vi.mock('@oxy.so/bloom/text-field', async () => {
  const ReactModule = await import('react');
  return {
    TextFieldInput: (props: Record<string, unknown>) =>
      ReactModule.createElement('TextField', props),
  };
});
vi.mock('@oxy.so/bloom/textarea', async () => {
  const ReactModule = await import('react');
  return {
    Textarea: (props: Record<string, unknown>) => ReactModule.createElement('Textarea', props),
  };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: Record<string, unknown>) => ReactModule.createElement('Chip', props) };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Muted: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Muted', null, children),
  };
});

import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import { SpaceDialog, type SpaceDialogState } from '../space-dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const agents = Array.from(
  { length: 8 },
  (_, i) => ({ _id: `a${i + 1}`, name: `Agent ${i + 1}`, handle: `agent${i + 1}` }) as Agent,
);

const existing: Space = {
  id: 's1',
  name: 'Equipo',
  instructions: 'Lanzar la beta',
  conversationId: 'room1',
  memberAgentIds: ['a1', 'a2', 'a3', 'a4'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let renderer: ReactTestRenderer;
const onClose = vi.fn();
const onSubmit = vi.fn();

async function mount(state: SpaceDialogState) {
  await act(async () => {
    renderer = create(
      <SpaceDialog state={state} candidates={agents} onClose={onClose} onSubmit={onSubmit} />,
    );
  });
}

const is = (node: ReactTestInstance, name: string) => (node.type as unknown) === name;
const field = (name: string) => renderer.root.find((n) => is(n, name));
const chips = () => renderer.root.findAll((n) => is(n, 'Chip'));
const save = () => renderer.root.findAll((n) => is(n, 'DialogAction')).at(-1)!;

async function type(name: 'TextField' | 'Textarea', value: string) {
  await act(async () => {
    const props = field(name).props;
    (props.onValueChange ?? props.onChangeText)(value);
  });
}
async function toggle(index: number) {
  await act(async () => chips()[index]!.props.onPress());
}
async function press() {
  await act(async () => {
    await save().props.onPress();
  });
}

beforeEach(() => {
  onClose.mockReset();
  onSubmit.mockReset().mockResolvedValue(undefined);
  world.toast.error.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
});

describe('creating a space', () => {
  it('asks the name, the brief and the agents, and cannot be created without a name', async () => {
    await mount({ mode: 'create' });
    expect(field('Textarea').props.placeholder).toBe('spaces.briefPlaceholder');
    expect(chips()).toHaveLength(8);
    expect(save().props.disabled).toBe(true);
    await type('TextField', '   ');
    expect(save().props.disabled).toBe(true);
    await type('TextField', 'Equipo');
    expect(save().props.disabled).toBe(false);
  });

  it('submits the strict body: trimmed name, the brief and the agents picked, in order', async () => {
    await mount({ mode: 'create' });
    await type('TextField', '  Equipo ');
    await type('Textarea', ' Lanzar la beta ');
    await toggle(2);
    await toggle(0);
    await press();
    expect(onSubmit).toHaveBeenCalledWith(
      { mode: 'create' },
      { name: 'Equipo', instructions: 'Lanzar la beta', agentIds: ['a3', 'a1'] },
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves out an empty brief and no agents instead of sending empty fields', async () => {
    await mount({ mode: 'create' });
    await type('TextField', 'Equipo');
    await press();
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'create' }, { name: 'Equipo' });
  });

  it('holds at most six agents: a seventh press picks nothing', async () => {
    await mount({ mode: 'create' });
    await type('TextField', 'Equipo');
    for (let i = 0; i < 7; i += 1) await toggle(i);
    await press();
    expect(onSubmit.mock.calls[0]![1].agentIds).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('refuses a name over 60 characters', async () => {
    await mount({ mode: 'create' });
    await type('TextField', 'x'.repeat(61));
    expect(save().props.disabled).toBe(true);
    await type('TextField', 'x'.repeat(60));
    expect(save().props.disabled).toBe(false);
  });

  it('stays open and says why when the API refuses: the space is full', async () => {
    onSubmit.mockRejectedValue({ code: 'space_full' });
    await mount({ mode: 'create' });
    await type('TextField', 'Equipo');
    await press();
    expect(onClose).not.toHaveBeenCalled();
    expect(world.toast.error).toHaveBeenCalledWith('spaces.full:{"count":6}');
    // The person can try again.
    expect(save().props.disabled).toBe(false);
  });
});

describe('changing a space', () => {
  it('renames with the name alone, and only when it changed', async () => {
    await mount({ mode: 'rename', space: existing });
    expect(() => field('Textarea')).toThrow();
    expect(chips()).toHaveLength(0);
    expect(field('TextField').props.value).toBe('Equipo');
    expect(save().props.disabled).toBe(true);
    await type('TextField', 'Otro');
    await press();
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'rename', space: existing }, { name: 'Otro' });
  });

  it('rewrites the brief with the brief alone, and an empty one clears it', async () => {
    await mount({ mode: 'brief', space: existing });
    expect(() => field('TextField')).toThrow();
    expect(field('Textarea').props.value).toBe('Lanzar la beta');
    await type('Textarea', '');
    await press();
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'brief', space: existing }, { instructions: '' });
  });

  it('adds agents up to the seats the space has left', async () => {
    await mount({ mode: 'addAgents', space: existing });
    expect(save().props.disabled).toBe(true);
    for (let i = 0; i < 5; i += 1) await toggle(i);
    await press();
    // Four of six seats are taken: two more fit.
    expect(onSubmit.mock.calls[0]![1]).toEqual({ agentIds: ['a1', 'a2'] });
  });
});
