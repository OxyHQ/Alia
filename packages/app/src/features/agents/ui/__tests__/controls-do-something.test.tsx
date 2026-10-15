import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every control does what it says, or is not there (#608, rule 6).
 *
 * Each case below was a control on a real screen whose press did nothing, or
 * something other than its label: a "Report" that toasted "submitted" and sent
 * nothing, a "Bookmark" nothing ever read, and three agent settings the server
 * stored and never used. (The canvas form's Submit is pinned in the SDK, the Library row beside
 * its component.) Bloom is stubbed at its boundary as host elements
 * carrying their props, so a query reads the component's decisions straight
 * off the tree; the words come from the real catalog.
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

vi.mock('react-native', async () => hosts('View', 'Text', 'ScrollView'));
vi.mock('@oxy.so/bloom/button-group', async () => hosts('ButtonGroup', 'ButtonGroupItem'));
vi.mock('@oxy.so/bloom/icons/RiShare2Line', async () => hosts('RiShare2Line'));
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
vi.mock('@oxy.so/bloom/card', async () => hosts('Card', 'CardBody'));
vi.mock('@oxy.so/bloom/chip', async () => hosts('Chip'));
vi.mock('@oxy.so/bloom/icons', async () => hosts('RiAddLine', 'RiCloseLine'));
vi.mock('@oxy.so/bloom/label', async () => hosts('Label'));
vi.mock('@oxy.so/bloom/segmented-control', async () =>
  hosts('SegmentedControl', 'SegmentedControlItem', 'SegmentedControlItemText'),
);
vi.mock('@oxy.so/bloom/settings-list', async () => ({
  ...(await hosts('SettingsListGroup')),
  SettingsListItem: await slotted('SettingsListItem', ['title', 'rightElement']),
}));
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/textarea', async () => hosts('Textarea'));
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text', 'Muted'));

import { AgentHeaderActions } from '@/features/agents/ui/detail/agent-header-actions';
import { ArchetypeConfigSection } from '@/features/agents/ui/edit/archetype-config';

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
  return renderer!.root;
}

const all = (root: ReactTestInstance, type: string) => root.findAll((node) => node.type === type);

/** Every string the tree renders, as one list. */
function texts(root: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') out.push(node);
    else node.children.forEach(walk);
  };
  walk(root);
  return out;
}

describe('the agent header', () => {
  const props = {
    isOwner: true,
    canChat: true,
    price: 12,
    onEdit: vi.fn(),
    onChat: vi.fn(),
    onStartTask: vi.fn(),
    onShare: vi.fn(),
  };

  it('offers only what it can do, each wired to a handler', () => {
    const root = render(<AgentHeaderActions {...props} />);
    const items = all(root, 'ButtonGroupItem');
    expect(items.map((item) => item.props.accessibilityLabel ?? texts(item).join(''))).toEqual([
      'Edit',
      'Chat',
      'Start task · 12 credits',
      'Share',
    ]);
    expect(items.every((item) => typeof item.props.onPress === 'function')).toBe(true);
  });

  it('offers no Chat on a private agent this person cannot talk to', () => {
    const root = render(<AgentHeaderActions {...props} isOwner={false} canChat={false} />);
    const labels = all(root, 'ButtonGroupItem').map(
      (item) => item.props.accessibilityLabel ?? texts(item).join(''),
    );
    expect(labels).toEqual(['Start task · 12 credits', 'Share']);
  });

  it('has no Report or Bookmark: nothing received a report, nothing read a bookmark', () => {
    const root = render(<AgentHeaderActions {...props} />);
    expect(all(root, 'DropdownMenuItem')).toHaveLength(0);
    expect(texts(root).join(' ')).not.toMatch(/report|bookmark/i);
  });
});

describe('an agent’s kind-specific settings', () => {
  it('for a status update: the template and the comparison, no schedule and no delivery channels', () => {
    const onChange = vi.fn();
    const root = render(
      <ArchetypeConfigSection archetype="status_update" config={{}} onChange={onChange} />,
    );
    const words = texts(root).join(' ');
    expect(words).toContain('Report template');
    expect(words).toContain('Compare with previous report');
    // Stored in `archetypeConfig` and read by nothing on the server.
    expect(words).not.toMatch(/Schedule|Daily|Interval|Delivery/);
    expect(all(root, 'SegmentedControl')).toHaveLength(0);
    expect(all(root, 'Chip')).toHaveLength(0);
  });

  it('for a router: channels and rules, no escalation timeout', () => {
    const root = render(
      <ArchetypeConfigSection
        archetype="task_router"
        config={{
          routingRules: [
            {
              condition: 'billing',
              priority: 'high',
              assignTo: { type: 'team', id: 't1', name: 'Finance' },
            },
          ],
        }}
        onChange={vi.fn()}
      />,
    );
    const words = texts(root).join(' ');
    expect(words).toContain('Inbound channels');
    expect(words).toContain('Routing rules');
    expect(words).not.toMatch(/Escalation/);
    // The two inputs left are the rule's condition and its target.
    expect(all(root, 'TextFieldInput').map((input) => input.props.value)).toEqual([
      'billing',
      'Finance',
    ]);
  });
});
