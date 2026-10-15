import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A generated form on the canvas does only what something can honour: it offers Submit when the
 * host receives its values, and sends what was typed when it does.
 */

const { hosts } = vi.hoisted(() => ({
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

vi.mock('react-native', async () => hosts('View'));
vi.mock('../../../src/lib/labels', () => ({ useLabels: () => ({ t: (key: string) => key }) }));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/checkbox', async () => hosts('Checkbox'));
vi.mock('@oxy.so/bloom/field', async () => hosts('Field'));
vi.mock('@oxy.so/bloom/select', async () =>
  hosts(
    'Select',
    'SelectContent',
    'SelectIcon',
    'SelectItem',
    'SelectItemIndicator',
    'SelectItemText',
    'SelectTrigger',
    'SelectValue',
  ),
);
vi.mock('@oxy.so/bloom/text-field', async () => hosts('TextFieldInput'));

import { FormRenderer } from '../../../src/components/canvas/FormRenderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(element: React.ReactElement): ReactTestInstance {
  act(() => {
    renderer = create(element);
  });
  return (renderer as unknown as ReactTestRenderer).root;
}

const all = (root: ReactTestInstance, type: string) => root.findAll((node) => node.type === type);

describe('a generated form on the canvas', () => {
  const data = { fields: [{ name: 'city', type: 'text' as const, label: 'City' }] };

  it('offers no Submit when nothing receives its values', () => {
    const root = render(<FormRenderer data={data} />);
    expect(all(root, 'Button')).toHaveLength(0);
  });

  it('sends what was typed when something does', () => {
    const onSubmit = vi.fn();
    const root = render(<FormRenderer data={data} onSubmit={onSubmit} />);
    act(() => all(root, 'TextFieldInput')[0]?.props.onValueChange('Lugo'));
    act(() => all(root, 'Button')[0]?.props.onPress());
    expect(onSubmit).toHaveBeenCalledWith({ city: 'Lugo' });
  });
});
