import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * "Sugerencias de inicio" (ADR 0020 §6): the owner writes up to six starters,
 * a title and the message each one sends; the draft saves only the complete
 * ones, so a row still being written never fails the editor's autosave.
 */

const { hosts, slotted } = vi.hoisted(() => ({
  slotted: async (name: string, slots: string[]) => {
    const ReactModule = await import('react');
    return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(
        name,
        props,
        ...slots.map((slot) => (props[slot] ?? null) as React.ReactNode),
        children as React.ReactNode,
      );
  },
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          ReactModule.createElement(name, props, children as React.ReactNode),
      ]),
    );
  },
}));

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/icons', async () => hosts('RiAddLine', 'RiCloseLine'));
vi.mock('@oxy.so/bloom/text-field', async () => hosts('TextFieldInput'));
// `savableStarters` lives beside the draft; the draft's own reads are not this file's subject.
vi.mock('@alia.onl/sdk', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('@/features/agents/runtime/use-agents', () => ({ useUpdateAgent: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));
vi.mock('@oxy.so/bloom/settings-list', async () => ({
  ...(await hosts('SettingsListGroup')),
  SettingsListItem: await slotted('SettingsListItem', ['rightElement']),
}));

const { AgentStartersSection } = await import('@/features/agents/ui/edit/agent-starters-section');
const { savableStarters } = await import('@/features/agents/runtime/use-agent-autosave');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const GRACIA = { title: 'Pisos en Gràcia', prompt: 'Busca pisos en Gràcia por menos de 1.200 €' };
const RENT = { title: 'Me suben el alquiler', prompt: '¿Qué derechos tengo?' };

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(starters: Array<{ title: string; prompt: string }>, onChange = vi.fn()) {
  act(() => {
    renderer = create(<AgentStartersSection starters={starters} onChange={onChange} />);
  });
  if (!renderer) throw new Error('not rendered');
  return { tree: renderer as ReactTestRenderer, onChange };
}

const inputs = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === 'TextFieldInput');
const addRow = (tree: ReactTestRenderer) =>
  tree.root.findAll(
    (node) => (node.type as unknown) === 'SettingsListItem' && node.props.title === 'Add a starter',
  );

describe('Conversation starters', () => {
  it('shows each starter as a title and the message it sends', () => {
    const { tree } = render([GRACIA, RENT]);
    expect(inputs(tree).map((input) => input.props.value)).toEqual([
      GRACIA.title,
      GRACIA.prompt,
      RENT.title,
      RENT.prompt,
    ]);
    expect(inputs(tree)[0]?.props.maxLength).toBe(60);
    expect(inputs(tree)[1]?.props.maxLength).toBe(500);
  });

  it('edits one starter in place', () => {
    const { tree, onChange } = render([GRACIA, RENT]);
    act(() => inputs(tree)[3]?.props.onChangeText('¿Me pueden subir el alquiler?'));
    expect(onChange).toHaveBeenCalledWith([
      GRACIA,
      { ...RENT, prompt: '¿Me pueden subir el alquiler?' },
    ]);
  });

  it('adds an empty row, and removes one', () => {
    const { tree, onChange } = render([GRACIA, RENT]);
    act(() => addRow(tree)[0]?.props.onPress());
    expect(onChange).toHaveBeenLastCalledWith([GRACIA, RENT, { title: '', prompt: '' }]);
    const remove = tree.root.findAll((node) => (node.type as unknown) === 'Button')[0];
    act(() => remove?.props.onPress());
    expect(onChange).toHaveBeenLastCalledWith([RENT]);
  });

  it('offers no seventh starter', () => {
    const { tree } = render(Array.from({ length: 6 }, () => GRACIA));
    expect(addRow(tree)).toEqual([]);
  });
});

describe('what the draft saves', () => {
  it('sends only complete starters, trimmed, at most six', () => {
    expect(
      savableStarters([
        { title: '  Pisos en Gràcia ', prompt: ' Busca pisos ' },
        { title: 'Sin mensaje', prompt: '   ' },
        { title: '', prompt: 'Sin título' },
        ...Array.from({ length: 7 }, () => RENT),
      ]),
    ).toEqual([{ title: 'Pisos en Gràcia', prompt: 'Busca pisos' }, ...Array(5).fill(RENT)]);
  });
});
