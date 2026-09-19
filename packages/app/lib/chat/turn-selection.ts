/**
 * What a turn may be sent WITH: the skills and the connector the composer
 * offers for the next message, as data rather than as JSX.
 *
 * The composer used to decide both inside its menu's markup, and one `&&`
 * there decided something nobody chose. The skills block sat inside
 * `runnableConnectors.length > 0`:
 *
 *     {runnableConnectors.length > 0 && (
 *       <>
 *         {availableSkills.length > 0 && ( …the skills… )}
 *         …the connectors…
 *       </>
 *     )}
 *
 * so an account with skills installed and no running MCP server — the ordinary
 * shape of an account, since skills need no server at all — was offered none of
 * them. Alia can still load a skill on its own from the index in its system
 * prompt, which is exactly why the gap was easy to miss: the feature did not
 * look broken, it looked unnecessary.
 *
 * They are two independent axes and this file states them as two, so the menu
 * renders what it is given instead of deriving availability from a sibling.
 * Being a plain function it is also testable without mounting a composer.
 */

import type { InstalledMcpServer } from '@/lib/hooks/use-mcp-servers';
import type { InstalledSkill } from '@/lib/hooks/use-skills';

/** One skill the person may name for the next message. */
export interface TurnSkillOption {
  id: string;
  /** What the request carries. Never the display name. */
  name: string;
  label: string;
  description: string;
  selected: boolean;
}

/** One connector whose tools the next message may reach. */
export interface TurnConnectorOption {
  id: string;
  label: string;
  /** Remote URL or a glyph name; the menu decides how to draw it. */
  icon?: string;
  toolCount: number;
  selected: boolean;
}

export interface TurnSelectionOptions {
  skills: TurnSkillOption[];
  connectors: TurnConnectorOption[];
}

/**
 * A connector whose tools a turn can actually reach.
 *
 * All four conditions, because each one alone is satisfiable by a server that
 * would answer nothing: disabled, not running, running on the person's own
 * machine rather than where the turn executes, or running and exporting no
 * tools.
 */
export function isRunnableConnector(server: InstalledMcpServer): boolean {
  return (
    server.enabled
    && server.status === 'running'
    && server.runtime === 'server'
    && server.tools.length > 0
  );
}

/**
 * The two lists the composer's capability menu draws, given what the account
 * has installed and what this turn has already selected.
 *
 * Neither list gates the other: an account with skills and no runnable
 * connector gets its skills, and an account with a connector and no skills
 * gets its connector.
 */
export function buildTurnSelection(input: {
  installedSkills: readonly InstalledSkill[];
  installedConnectors: readonly InstalledMcpServer[];
  selectedSkillNames: readonly string[];
  selectedConnectorId: string | null;
}): TurnSelectionOptions {
  const selectedSkills = new Set(input.selectedSkillNames);

  return {
    skills: input.installedSkills
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        id: skill._id,
        name: skill.name,
        label: skill.displayName,
        description: skill.description,
        selected: selectedSkills.has(skill.name),
      })),
    connectors: input.installedConnectors
      .filter(isRunnableConnector)
      .map((server) => ({
        id: server._id,
        label: server.displayName,
        icon: server.icon,
        toolCount: server.tools.length,
        selected: input.selectedConnectorId === server._id,
      })),
  };
}

/** Add or remove a skill from the turn, by the name the request carries. */
export function toggleSkillName(
  current: readonly string[],
  name: string,
): string[] {
  return current.includes(name)
    ? current.filter((existing) => existing !== name)
    : [...current, name];
}

/** Choose a connector for the turn, or unchoose the one already chosen. */
export function toggleConnectorId(
  current: string | null,
  id: string,
): string | null {
  return current === id ? null : id;
}
