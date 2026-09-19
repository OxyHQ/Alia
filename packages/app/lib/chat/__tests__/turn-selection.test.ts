import { describe, expect, it } from 'vitest';

import {
  buildTurnSelection,
  isRunnableConnector,
  toggleConnectorId,
  toggleSkillName,
} from '@/lib/chat/turn-selection';
import type { InstalledMcpServer } from '@/lib/hooks/use-mcp-servers';
import type { InstalledSkill } from '@/lib/hooks/use-skills';

/**
 * Skills and connectors are two axes, and the composer used to treat them as
 * one.
 *
 * In `chat-page-content.tsx` the skills block was nested inside
 * `runnableConnectors.length > 0`, so the whole "use this skill on this turn"
 * feature was invisible to any account that had not also got an MCP server
 * running on the server runtime with at least one tool. A skill needs none of
 * that — it is text Alia loads — and the two lists come from two different
 * endpoints, so nothing about the coupling was intentional.
 *
 * The first case below is that bug stated directly: skills installed, no
 * runnable connector, skills must still be offered. The rest guard the
 * conditions that were correct and must stay correct — a connector is only
 * offered when a turn could actually reach its tools, and the request carries
 * the skill's `name`, never its translated `displayName`.
 */

function skill(over: Partial<InstalledSkill> & { _id: string; name: string }): InstalledSkill {
  return {
    displayName: over.name,
    description: '',
    license: null,
    compatibility: null,
    allowedTools: [],
    specMetadata: {},
    source: 'registry',
    sourceRepo: null,
    sourcePath: null,
    sourceUrl: null,
    publisher: null,
    tags: [],
    icon: null,
    color: null,
    ownerOxyUserId: null,
    visibility: 'private',
    installCount: 0,
    createdAt: '',
    updatedAt: '',
    enabled: true,
    autoInvoke: false,
    pinnedVersion: null,
    installedVersion: 1,
    ...over,
  } as InstalledSkill;
}

function connector(over: Partial<InstalledMcpServer> & { _id: string }): InstalledMcpServer {
  return {
    name: over._id,
    displayName: over._id,
    source: 'registry',
    transport: 'streamable-http',
    runtime: 'server',
    config: {},
    status: 'running',
    tools: [{ name: 't', description: '', inputSchema: {} }],
    enabled: true,
    ...over,
  } as InstalledMcpServer;
}

describe('buildTurnSelection', () => {
  it('offers installed skills when no connector is runnable', () => {
    const selection = buildTurnSelection({
      installedSkills: [skill({ _id: 's1', name: 'pdf-forms' })],
      installedConnectors: [],
      selectedSkillNames: [],
      selectedConnectorId: null,
    });

    expect(selection.connectors).toEqual([]);
    expect(selection.skills.map((s) => s.name)).toEqual(['pdf-forms']);
  });

  it('offers connectors when no skill is installed', () => {
    const selection = buildTurnSelection({
      installedSkills: [],
      installedConnectors: [connector({ _id: 'c1', displayName: 'Linear' })],
      selectedSkillNames: [],
      selectedConnectorId: null,
    });

    expect(selection.skills).toEqual([]);
    expect(selection.connectors.map((c) => c.label)).toEqual(['Linear']);
  });

  it('leaves a disabled skill out', () => {
    const selection = buildTurnSelection({
      installedSkills: [
        skill({ _id: 's1', name: 'on' }),
        skill({ _id: 's2', name: 'off', enabled: false }),
      ],
      installedConnectors: [],
      selectedSkillNames: [],
      selectedConnectorId: null,
    });

    expect(selection.skills.map((s) => s.name)).toEqual(['on']);
  });

  it('marks what this turn already selected', () => {
    const selection = buildTurnSelection({
      installedSkills: [
        skill({ _id: 's1', name: 'chosen' }),
        skill({ _id: 's2', name: 'not-chosen' }),
      ],
      installedConnectors: [
        connector({ _id: 'c1' }),
        connector({ _id: 'c2' }),
      ],
      selectedSkillNames: ['chosen'],
      selectedConnectorId: 'c2',
    });

    expect(selection.skills.filter((s) => s.selected).map((s) => s.name)).toEqual(['chosen']);
    expect(selection.connectors.filter((c) => c.selected).map((c) => c.id)).toEqual(['c2']);
  });

  it('carries the skill name the request needs, not the label', () => {
    const selection = buildTurnSelection({
      installedSkills: [skill({ _id: 's1', name: 'pdf-forms', displayName: 'PDF Forms' })],
      installedConnectors: [],
      selectedSkillNames: [],
      selectedConnectorId: null,
    });

    expect(selection.skills[0]).toMatchObject({ name: 'pdf-forms', label: 'PDF Forms' });
  });
});

describe('isRunnableConnector', () => {
  const cases: Array<[string, Partial<InstalledMcpServer>]> = [
    ['disabled', { enabled: false }],
    ['not running', { status: 'stopped' }],
    ['erroring', { status: 'error' }],
    ['on the local runtime', { runtime: 'local' }],
    ['exporting no tools', { tools: [] }],
  ];

  it.each(cases)('rejects a connector that is %s', (_label, over) => {
    expect(isRunnableConnector(connector({ _id: 'c1', ...over }))).toBe(false);
  });

  it('accepts a running server connector with tools', () => {
    expect(isRunnableConnector(connector({ _id: 'c1' }))).toBe(true);
  });
});

describe('toggles', () => {
  it('adds and removes a skill by name', () => {
    expect(toggleSkillName([], 'a')).toEqual(['a']);
    expect(toggleSkillName(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('selects one connector at a time, and unselects the chosen one', () => {
    expect(toggleConnectorId(null, 'c1')).toBe('c1');
    expect(toggleConnectorId('c1', 'c2')).toBe('c2');
    expect(toggleConnectorId('c1', 'c1')).toBeNull();
  });
});
