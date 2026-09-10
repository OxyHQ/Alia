import { describe, expect, it } from 'vitest';
import { parseAliaTeamMarkdown, serializeAliaTeamMarkdown, type AliaTeamPackage } from '../team-package.js';

const TEAM: AliaTeamPackage = {
  format: 'alia.team', version: 1, name: 'Launch', description: '', coordinator: 'lead',
  members: [{ key: 'lead', name: 'Lead', tagline: '', instructions: 'Coordinate.', skills: [] }],
  channels: [{ key: 'build', name: 'Build', instructions: '', responder: 'lead' }], automations: [],
};

describe('alia.team packages', () => {
  it('round-trips Markdown and frontmatter', () => {
    const parsed = parseAliaTeamMarkdown(serializeAliaTeamMarkdown(TEAM, '# Playbook\nShip safely.'));
    expect(parsed.manifest).toEqual(TEAM);
    expect(parsed.playbook).toContain('Ship safely');
  });

  it('rejects privileges and unknown responders', () => {
    expect(() => parseAliaTeamMarkdown(serializeAliaTeamMarkdown({
      ...TEAM, channels: [{ ...TEAM.channels[0]!, responder: 'missing' }],
    }))).toThrow('Unknown channel responder');
    expect(() => parseAliaTeamMarkdown(`---\nformat: alia.team\nversion: 1\nname: Bad\ncoordinator: lead\nmembers:\n  - key: lead\n    name: Lead\n    grants: [shell]\n---\n`)).toThrow();
  });
});
