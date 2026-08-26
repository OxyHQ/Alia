import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The grant rows an owner actually touches, and the two ways of granting agents.
 *
 * The screen is where "all your active agents" and "these two, by name" become
 * visible at all, so the cases below are about what a person can DO: that both
 * shapes are offered, that the family-wide row does not silently leave the
 * per-agent switches live and inert, and that what leaves this component is the
 * grant string the SERVER sent — never one this side assembled, because a grant
 * spelled differently is refused on write and dropped on read, silently in both
 * directions.
 *
 * The rows are fixtures shaped exactly as `GET /agents/capability-connectors`
 * serves them. What the endpoint actually puts in them is asserted server-side,
 * where the database is.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable'), Text: host('Text') };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);
  return {
    AppWindow: icon('AppWindow'),
    Brain: icon('Brain'),
    Globe: icon('Globe'),
    MessageSquare: icon('MessageSquare'),
    Shapes: icon('Shapes'),
    Users: icon('Users'),
  };
});

/**
 * The Material glyphs the family list imports. Hoisted factories cannot share a
 * helper — `vi.mock` runs before any top-level binding exists — so each one
 * builds its own, which is why they are spelled out rather than looped.
 */
vi.mock('@/components/ui/action-key-icon', async () => {
  const ReactModule = await import('react');
  return { ActionKeyIcon: (props: Record<string, unknown>) => ReactModule.createElement('Icon', props) };
});
vi.mock('@/components/ui/files-icon', async () => {
  const ReactModule = await import('react');
  return { FilesIcon: (props: Record<string, unknown>) => ReactModule.createElement('Icon', props) };
});
vi.mock('@/components/ui/terminal-icon', async () => {
  const ReactModule = await import('react');
  return { TerminalIcon: (props: Record<string, unknown>) => ReactModule.createElement('Icon', props) };
});
vi.mock('@/components/ui/icons/agent-robot-icon', async () => {
  const ReactModule = await import('react');
  return { AgentRobotIcon: (props: Record<string, unknown>) => ReactModule.createElement('Icon', props) };
});
vi.mock('@/components/ui/icons/clock-icon', async () => {
  const ReactModule = await import('react');
  return { ClockIcon: (props: Record<string, unknown>) => ReactModule.createElement('Icon', props) };
});

vi.mock('@/components/ui/switch', async () => {
  const ReactModule = await import('react');
  return {
    Switch: (props: Record<string, unknown>) => ReactModule.createElement('Switch', props),
  };
});

vi.mock('@oxyhq/bloom/settings-list', async () => {
  const ReactModule = await import('react');
  return {
    SettingsListGroup: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Group', props, children),
    /**
     * `rightElement` and `icon` are PROPS holding elements, and the real
     * component renders them. A mock that spreads props without rendering them
     * would hide every switch from the tree and read as "the row has no switch".
     */
    SettingsListItem: ({
      rightElement,
      icon,
      ...props
    }: Record<string, unknown> & { rightElement?: React.ReactNode; icon?: React.ReactNode }) =>
      ReactModule.createElement('Item', props, icon, rightElement),
  };
});

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { foreground: '#000', mutedForeground: '#888' } }),
}));

import { AgentConnectorGrants } from '../agent-connector-grants';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

/** The rows the server sends for an owner with two agents. */
const AGENT_ROWS = [
  {
    grant: 'agent',
    family: 'agent',
    label: 'All your active agents',
    detail: 'New agents join automatically; switching one off removes it',
  },
  { grant: 'agent:ag-1', family: 'agent', label: 'Archivist', detail: 'keeps the dates' },
  { grant: 'agent:ag-2', family: 'agent', label: 'Scribe', detail: 'writes it down' },
];

function render(grants: string[], onChange = vi.fn()) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <AgentConnectorGrants connectors={AGENT_ROWS} grants={grants} onChange={onChange} />,
    );
  });
  if (next === undefined) throw new Error('the grants section did not render');
  renderer = next;
  return { root: next.root, onChange };
}

/**
 * Host elements by name.
 *
 * A string VARIABLE, never a literal: `findAll` is typed for components, so
 * `node.type === 'Item'` is a comparison `tsc` rejects as impossible while the
 * same comparison against a `string` parameter is fine. Same shape the other
 * renderer tests in this directory use.
 */
function hosts(node: { findAll: ReactTestRenderer['root']['findAll'] }, name: string) {
  return node.findAll((candidate) => candidate.type === name);
}

/** Every row, by the title the person reads. */
function rows(root: ReactTestRenderer['root']) {
  return hosts(root, 'Item').map((node) => ({
    title: String(node.props.title),
    disabled: node.props.disabled === true,
    value: hosts(node, 'Switch')[0]?.props.value === true,
    toggle: () => {
      const change = hosts(node, 'Switch')[0]?.props.onValueChange;
      if (typeof change !== 'function') throw new Error(`no switch on ${String(node.props.title)}`);
      act(() => {
        change();
      });
    },
  }));
}

const row = (root: ReactTestRenderer['root'], title: string) => {
  const found = rows(root).find((candidate) => candidate.title === title);
  if (found === undefined) throw new Error(`no row titled ${title}`);
  return found;
};

describe('the two ways to grant an agent its owner\'s other agents', () => {
  it('offers the family-wide row and one row per agent, under one heading', () => {
    const { root } = render([]);

    expect(hosts(root, 'Group').map((group) => group.props.title)).toEqual(['Your agents']);
    expect(rows(root).map((entry) => entry.title)).toEqual([
      'All your active agents',
      'Archivist',
      'Scribe',
    ]);
    // Nothing is granted until somebody grants it. The list starts empty.
    expect(rows(root).every((entry) => !entry.value)).toBe(true);
  });

  it('sends back the exact grant string the server gave it', () => {
    const { root, onChange } = render([]);

    row(root, 'Archivist').toggle();

    // `agent:ag-1`, not a family and an id joined here. This side never writes
    // the separator, and this is the assertion that says so.
    expect(onChange).toHaveBeenCalledWith(['agent:ag-1']);
  });

  it('turns one agent on without touching the others', () => {
    const { root } = render(['agent:ag-1']);

    expect(row(root, 'Archivist').value).toBe(true);
    expect(row(root, 'Scribe').value).toBe(false);
    // The positive control for the case below: an individual grant leaves every
    // switch live, so "disabled" there is the family-wide row's doing.
    expect(rows(root).every((entry) => !entry.disabled)).toBe(true);
  });

  it('shows the individual agents as granted, and locked, while ALL is on', () => {
    const { root } = render(['agent']);

    expect(row(root, 'All your active agents').value).toBe(true);
    /**
     * Both halves matter. Reading as OFF would tell an owner the agents are not
     * reachable when they are; staying live would offer a switch that removes a
     * grant nobody holds, and changes nothing about what the agent can do.
     */
    expect(row(root, 'Archivist').value).toBe(true);
    expect(row(root, 'Archivist').disabled).toBe(true);
    expect(row(root, 'All your active agents').disabled).toBe(false);
  });

  it('leaves a per-agent grant in place when ALL is switched off again', () => {
    const { root, onChange } = render(['agent', 'agent:ag-1']);

    row(root, 'All your active agents').toggle();

    // Only the family row is removed. An owner who narrowed from "all" to "one"
    // would otherwise lose the narrower grant in the same gesture.
    expect(onChange).toHaveBeenCalledWith(['agent:ag-1']);
  });

  it('groups each family separately, so a connector cannot land under agents', () => {
    let next: ReactTestRenderer | undefined;
    const connectors = [
      ...AGENT_ROWS,
      { grant: 'mcp:c-1', family: 'mcp', label: 'Notion', detail: '4 tools' },
    ];
    act(() => {
      next = create(
        <AgentConnectorGrants connectors={connectors} grants={['agent']} onChange={vi.fn()} />,
      );
    });
    if (next === undefined) throw new Error('the grants section did not render');
    renderer = next;

    expect(hosts(next.root, 'Group').map((group) => group.props.title)).toEqual([
      'Your agents',
      'Connectors',
    ]);
    // The subsumption is per FAMILY: holding `agent` says nothing about an MCP
    // connector, and a rule written over the whole list would have locked it.
    expect(row(next.root, 'Notion').disabled).toBe(false);
    expect(row(next.root, 'Notion').value).toBe(false);
  });
});
