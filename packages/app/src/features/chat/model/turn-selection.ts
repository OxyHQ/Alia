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

import type { Connection } from '@gemies/sdk/connectors';
import type { InstalledSkill } from '@/features/skills/runtime/use-skills';

/** One skill the person may name for the next message. */
interface TurnSkillOption {
  id: string;
  /** What the request carries. Never the display name. */
  name: string;
  label: string;
  description: string;
  selected: boolean;
}

/** One connector whose tools the next message may reach. */
interface TurnConnectorOption {
  id: string;
  /** The connector and, when it has one, which of the person's accounts: `Notion · Work`. */
  label: string;
  /** For `ConnectorLogo`: a path on the API's origin, or `null` for a monogram. */
  name: string;
  logoUrl: string | null;
  toolCount: number;
  selected: boolean;
}

export interface TurnSelectionOptions {
  skills: TurnSkillOption[];
  connectors: TurnConnectorOption[];
}

/**
 * A connector whose tools a turn can actually reach: connected, and exporting tools. One that
 * lost its connection, or exports none, would answer nothing.
 */
export function isRunnableConnector(connection: Connection): boolean {
  return connection.status === 'running' && connection.tools.length > 0;
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
  installedConnectors: readonly Connection[];
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
    connectors: input.installedConnectors.filter(isRunnableConnector).map((connection) => ({
      id: connection._id,
      label: connection.accountLabel
        ? `${connection.displayName} · ${connection.accountLabel}`
        : connection.displayName,
      name: connection.displayName,
      logoUrl: connection.logoUrl,
      toolCount: connection.tools.length,
      selected: input.selectedConnectorId === connection._id,
    })),
  };
}

/** Add or remove a skill from the turn, by the name the request carries. */
export function toggleSkillName(current: readonly string[], name: string): string[] {
  return current.includes(name)
    ? current.filter((existing) => existing !== name)
    : [...current, name];
}

/** Choose a connector for the turn, or unchoose the one already chosen. */
export function toggleConnectorId(current: string | null, id: string): string | null {
  return current === id ? null : id;
}
