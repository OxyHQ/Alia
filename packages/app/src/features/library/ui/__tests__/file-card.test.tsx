import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A Library file row is a button only when a press has somewhere to go, and has a menu only when
 * the menu can delete: a row that highlighted and did nothing was a control that lied (#608,
 * rule 6). Bloom is stubbed at its boundary as host elements carrying their props, so a query
 * reads the component's decisions straight off the tree.
 */

const { hosts, slotted } = vi.hoisted(() => ({
  /** A host that also renders the elements it was handed as props, in order. */
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
vi.mock('@oxy.so/bloom/avatar', async () => hosts('Avatar'));
vi.mock('@oxy.so/bloom/dropdown-menu', async () =>
  hosts('DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuTrigger'),
);
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', async () => hosts('RiDeleteBinLine'));
vi.mock('@oxy.so/bloom/icons/RiFilePaper2Line', async () => hosts('RiFilePaper2Line'));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', async () => hosts('RiFileTextLine'));
vi.mock('@oxy.so/bloom/icons/RiImageLine', async () => hosts('RiImageLine'));
vi.mock('@oxy.so/bloom/icons/RiMoreFill', async () => hosts('RiMoreFill'));
vi.mock('@oxy.so/bloom/item', async () => ({ Item: await slotted('Item', ['title', 'trailing']) }));
vi.mock('@/features/library/runtime/library-store', () => ({}));

import { FileCard } from '@/features/library/ui/file-card';

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

describe('a Library file row', () => {
  const file = {
    _id: 'f1',
    name: 'notes.pdf',
    type: 'application/pdf',
    size: 2048,
    category: 'documents',
    createdAt: new Date(),
  } as unknown as React.ComponentProps<typeof FileCard>['file'];

  it('is not a button when a press has nowhere to go', () => {
    const root = render(<FileCard file={file} onDelete={vi.fn()} />);
    expect(all(root, 'Item')[0]?.props.onPress).toBeUndefined();
  });

  it('is one when it does, and hands the file over', () => {
    const onPress = vi.fn();
    const root = render(<FileCard file={file} onPress={onPress} />);
    act(() => all(root, 'Item')[0]?.props.onPress());
    expect(onPress).toHaveBeenCalledWith(file);
  });

  it('has a menu only when the menu can delete', () => {
    expect(all(render(<FileCard file={file} />), 'DropdownMenu')).toHaveLength(0);
    const onDelete = vi.fn();
    const root = render(<FileCard file={file} onDelete={onDelete} />);
    act(() => all(root, 'DropdownMenuItem')[0]?.props.onPress());
    expect(onDelete).toHaveBeenCalledWith(file);
  });
});
