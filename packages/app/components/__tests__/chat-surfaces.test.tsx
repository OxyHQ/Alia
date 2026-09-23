import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The chat's new Bloom surfaces, by what they DO rather than how they look:
 * the empty chat hands a picked suggestion back whole, the header's menu
 * offers exactly the actions the screen can honour, and a page's header on a
 * phone carries the menu and panel buttons the mobile header used to.
 */

const shell = vi.hoisted(() => ({
  value: null as null | Record<string, unknown>,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View') };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { primary: '#000' } }),
}));
vi.mock('@alia.onl/sdk', () => ({ IdentityMark: () => null }));

vi.mock('@oxy.so/bloom/empty-state', async () => {
  const ReactModule = await import('react');
  return {
    EmptyState: ({ title, description, footer }: Record<string, React.ReactNode>) =>
      ReactModule.createElement('EmptyState', { title, description }, footer),
  };
});
vi.mock('@oxy.so/bloom/chip', async () => {
  const ReactModule = await import('react');
  return {
    Chip: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Chip', props, children),
  };
});

vi.mock('@oxy.so/bloom/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    DropdownMenu: host('Menu'),
    DropdownMenuTrigger: host('Trigger'),
    DropdownMenuContent: host('Content'),
    DropdownMenuItem: host('MenuItem'),
    DropdownMenuSeparator: host('Separator'),
  };
});
vi.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
for (const icon of ['RiDeleteBinLine', 'RiDownloadLine', 'RiMoreFill', 'RiSearchLine', 'RiMenuLine']) {
  vi.doMock(`@oxy.so/bloom/icons/${icon}`, () => ({ [icon]: () => null }));
}

vi.mock('@oxy.so/bloom/ai-chat', () => ({ useAiChatShell: () => shell.value }));
vi.mock('@oxy.so/bloom/button-group', async () => {
  const ReactModule = await import('react');
  return {
    ButtonGroup: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('ButtonGroup', null, children),
    ButtonGroupItem: (props: Record<string, unknown>) =>
      ReactModule.createElement('ButtonGroupItem', props),
  };
});
vi.mock('@oxy.so/bloom/page-header', async () => {
  const ReactModule = await import('react');
  return {
    PageHeader: ({ leading, actions, ...props }: Record<string, React.ReactNode>) =>
      ReactModule.createElement('PageHeader', props, leading, actions),
  };
});

const { ChatEmptyState } = await import('@/components/chat/chat-empty-state');
const { ChatHeaderActions } = await import('@/components/chat/chat-header-actions');
const { ShellPageHeader } = await import('@/components/app-shell/page-chrome');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = create(element);
  });
  return renderer as unknown as ReactTestRenderer;
}
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  shell.value = null;
});

const all = (r: ReactTestRenderer, name: string): ReactTestInstance[] =>
  r.root.findAll((node) => node.type === name);

const SUGGESTION = {
  suggestionId: 's1',
  title: 'Plan a trip',
  text: 'Plan a three-day trip to Lisbon',
  isTemplate: false,
} as never;

describe('ChatEmptyState', () => {
  it('asks what it can help with, and offers each suggestion by its title', () => {
    const r = render(<ChatEmptyState suggestions={[SUGGESTION]} onPickSuggestion={vi.fn()} />);
    expect(all(r, 'EmptyState')[0].props.title).toBe('chat.emptyState.title');
    const chips = all(r, 'Chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].props.children).toBe('Plan a trip');
  });

  it('hands the whole suggestion back when one is pressed', () => {
    const onPick = vi.fn();
    const r = render(<ChatEmptyState suggestions={[SUGGESTION]} onPickSuggestion={onPick} />);
    act(() => all(r, 'Chip')[0].props.onPress());
    expect(onPick).toHaveBeenCalledWith(SUGGESTION);
  });

  it('draws the heading alone when there is nothing to suggest', () => {
    const r = render(<ChatEmptyState suggestions={[]} onPickSuggestion={vi.fn()} />);
    expect(all(r, 'Chip')).toHaveLength(0);
  });
});

describe('ChatHeaderActions', () => {
  const labels = (r: ReactTestRenderer) =>
    all(r, 'MenuItem').map((item) => item.props.children as string);

  it('offers search, export and delete when the screen can do all three', () => {
    const r = render(<ChatHeaderActions onSearch={vi.fn()} onExport={vi.fn()} onDelete={vi.fn()} />);
    expect(labels(r)).toEqual(['chatHeader.searchThread', 'chat.exportMarkdown', 'chat.deleteConversation']);
  });

  it('offers no search without a thread and no delete where it cannot delete', () => {
    const r = render(<ChatHeaderActions onExport={vi.fn()} />);
    expect(labels(r)).toEqual(['chat.exportMarkdown']);
  });

  it('never offers a share it could not honour', () => {
    const r = render(<ChatHeaderActions onSearch={vi.fn()} onExport={vi.fn()} onDelete={vi.fn()} />);
    expect(labels(r).some((label) => /share/i.test(label))).toBe(false);
  });

  it('runs the matching handler', () => {
    const onDelete = vi.fn();
    const r = render(<ChatHeaderActions onExport={vi.fn()} onDelete={onDelete} />);
    act(() => all(r, 'MenuItem')[1].props.onPress());
    expect(onDelete).toHaveBeenCalledOnce();
  });
});

describe('ShellPageHeader', () => {
  const baseShell = {
    compact: false,
    navCollapsed: false,
    hasNav: true,
    hasPanel: true,
    openNav: vi.fn(),
    openPanel: vi.fn(),
    panelLabel: 'Code',
    panelIcon: () => null,
    labels: { openNavigation: 'Open navigation', openPanel: (p: string) => `Open ${p}` },
  };
  const items = (r: ReactTestRenderer) =>
    all(r, 'ButtonGroupItem').map((item) => item.props.accessibilityLabel as string);

  it('is the page’s title and back alone on a wide screen', () => {
    shell.value = baseShell;
    const onBack = vi.fn();
    const r = render(<ShellPageHeader title="Skills" onBack={onBack} />);
    const header = all(r, 'PageHeader')[0];
    expect(header.props.title).toBe('Skills');
    expect(header.props.onBack).toBe(onBack);
    expect(items(r)).toEqual([]);
  });

  it('carries the nav menu and the panel button on a phone', () => {
    shell.value = { ...baseShell, compact: true, navCollapsed: true };
    const r = render(<ShellPageHeader title="Skills" />);
    expect(items(r)).toEqual(['Open navigation', 'Open Code']);
    act(() => all(r, 'ButtonGroupItem')[0].props.onPress());
    expect(baseShell.openNav).toHaveBeenCalled();
  });

  it('keeps the page’s own actions before the panel button', () => {
    shell.value = { ...baseShell, compact: true };
    const r = render(
      <ShellPageHeader title="Skills" actions={<ButtonGroupItemStub label="Create" />} />,
    );
    expect(items(r)).toEqual(['Create', 'Open Code']);
  });
});

function ButtonGroupItemStub({ label }: { label: string }) {
  return React.createElement('ButtonGroupItem', { accessibilityLabel: label });
}
