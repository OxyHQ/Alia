/**
 * The capability families, for the screens that show them.
 *
 * ONE list. It replaces two that overlapped and contradicted each other: eight
 * `AGENT_TOOLS` and six `PERMISSION_CONFIG` entries, fourteen rows for nine
 * ideas, rendered one above the other in the agent editor as "Tools" and
 * "Permissions". `web-browsing` and `network` shared a LABEL, `code-execution`
 * and `shell` shared an ICON, `file-management` and `File System` shared a
 * DESCRIPTION — so an owner had to set both to mean one thing, and the two
 * could disagree.
 *
 * ## This list is not the source of truth, and a test says so
 *
 * The vocabulary is `packages/api/src/domain/capability-grants.ts`; the
 * assembler reads it and the database stores it. What lives here is the part a
 * person sees — a label, a sentence and an icon — keyed by the same ids.
 * `packages/api/src/routes/__tests__/agent-editor-autosave.test.ts` reads THIS
 * file and asserts the ids match the API's, so the two cannot drift the way the
 * lists this replaced did.
 *
 * ## Instanced families are not toggles
 *
 * `mcp`, `integration` and `agent` are granted a row at a time,
 * so a grant names the row: `mcp:<connectorId>`, `agent:<agentId>`. They have
 * no entry in the list below, because a switch labelled "MCP Tools" would be a
 * grant over every connector the owner will ever install. They are their own
 * section, and its rows come from `GET /agents/capability-connectors` — which
 * also builds the grant STRING, so this side never writes the separator.
 *
 * `agent` is the one family that ALSO offers a row for the whole family ("all
 * your active agents"), and that row is a grant string like any other, built on
 * the same server. `packages/api/src/domain/capability-grants.ts` argues why
 * that one may and the other three may not.
 *
 * ## Bloom's icon contract
 *
 * Every glyph here — Bloom's own and the three drawn for Alia — takes Bloom's
 * icon props (`width`, `height`, `fill`), so the rows read as one list and the
 * colour is a value, which is all an `Svg` fill can be.
 */

import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLightbulbFlashLine } from '@oxy.so/bloom/icons/RiLightbulbFlashLine';
import { RiMessage2Line } from '@oxy.so/bloom/icons/RiMessage2Line';
import { RiShapesLine } from '@oxy.so/bloom/icons/RiShapesLine';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { RiWindowLine } from '@oxy.so/bloom/icons/RiWindowLine';
import { ActionKeyIcon } from '@/shared/ui/action-key-icon';
import { AgentRobotIcon } from '@/shared/ui/icons/agent-robot-icon';
import { ClockIcon } from '@/shared/ui/icons/clock-icon';

export interface CapabilityFamily {
  /** The grant string, exactly as it is stored and sent. */
  id: string;
  /** i18n keys — the words are the reader's language, not this file's. */
  label: string;
  description: string;
  icon: BloomIconComponent;
}

/**
 * The seven families granted whole, in the order they are shown.
 *
 * Ordered by how much of the world the family reaches — reading the web, then
 * reading pages step by step, then what the agent produces, the
 * person's memory and messages, then acting through other agents. Not
 * alphabetical: the ones with the widest blast radius are the ones an owner
 * should decide about first.
 *
 * `shell` and `files` are not here and must not come back as switches: they
 * granted a sandbox container production never had, so they could be turned
 * on and never do anything. The API drops them on read and on write.
 *
 * `mcp` keeps the Material Symbol the two lists this replaces already carried —
 * `ActionKeyIcon`, on the instanced family below.
 *
 * `delegation` and `automation` do not, and for the same reason #365 existed:
 * the SIDEBAR names both concepts too, so a glyph chosen only here would be the
 * second one for it. Both now draw the sheet's own — `AgentRobotIcon` and
 * `ClockIcon` — and the sidebar imports the same components, so "Other agents"
 * and "Agents", "Automations" and the scheduled-trigger grant, cannot disagree.
 */
export const CAPABILITY_FAMILIES: readonly CapabilityFamily[] = [
  {
    id: 'web',
    label: 'agents.capabilityFamily.web.label',
    description: 'agents.capabilityFamily.web.description',
    icon: RiGlobalLine,
  },
  {
    id: 'browser',
    label: 'agents.capabilityFamily.browser.label',
    description: 'agents.capabilityFamily.browser.description',
    icon: RiWindowLine,
  },
  {
    id: 'artifacts',
    label: 'agents.capabilityFamily.artifacts.label',
    description: 'agents.capabilityFamily.artifacts.description',
    icon: RiShapesLine,
  },
  {
    id: 'memory',
    label: 'agents.capabilityFamily.memory.label',
    description: 'agents.capabilityFamily.memory.description',
    icon: RiLightbulbFlashLine,
  },
  {
    id: 'messaging',
    label: 'agents.capabilityFamily.messaging.label',
    description: 'agents.capabilityFamily.messaging.description',
    icon: RiMessage2Line,
  },
  {
    id: 'automation',
    label: 'agents.capabilityFamily.automation.label',
    description: 'agents.capabilityFamily.automation.description',
    icon: ClockIcon,
  },
  {
    id: 'delegation',
    label: 'agents.capabilityFamily.delegation.label',
    description: 'agents.capabilityFamily.delegation.description',
    icon: AgentRobotIcon,
  },
];

/**
 * The autonomous runner's session primitives, by the family that grants each.
 *
 * Two of the three: `plan` is ungranted — it carries the completion signal, so
 * an agent denied it could never end its own run — and has no family to take an
 * icon from.
 *
 * This exists so the ACTIVITY PANEL and the agent editor draw one concept one
 * way. They did not: once the owner's Material glyphs landed, "Agent
 * Delegation" was `robot_2` in the editor and lucide's `Users` in the panel,
 * two screens apart inside one feature — the same label under two icons, which
 * is the duplication the single capability vocabulary exists to end. The
 * sidebar was the third such screen, and now takes its glyph from here too.
 *
 * The mapping is checked against the API's `FIXED_FAMILY_TOOLS` in
 * `agent-editor-autosave.test.ts`, so it cannot quietly disagree with the
 * assembler about which family owns a tool.
 */
const RUNTIME_TOOL_FAMILIES: Readonly<Record<string, string>> = {
  browser: 'browser',
  delegate: 'delegation',
};

/**
 * The icon a tool carries, taken from the family that grants it.
 *
 * `Object.hasOwn` rather than a truthiness check on the lookup: `toolName`
 * arrives from event metadata the server wrote, so it is an open string, and
 * `RUNTIME_TOOL_FAMILIES['constructor']` answers a FUNCTION inherited from
 * `Object.prototype`. An `if (icon)` guard passes on it and React is handed
 * something that is not a component — the shape
 * `packages/api/src/__tests__/prototype-keyed-lookups.test.ts` exists for.
 */
export function capabilityIconForTool(toolName: string): BloomIconComponent | undefined {
  if (!Object.hasOwn(RUNTIME_TOOL_FAMILIES, toolName)) return undefined;
  const family = RUNTIME_TOOL_FAMILIES[toolName];
  return CAPABILITY_FAMILIES.find((entry) => entry.id === family)?.icon;
}

/**
 * A connector the owner can grant, as `GET /agents/capability-connectors`
 * serves it.
 *
 * `grant` arrives ASSEMBLED. The client never joins a family to an id, because
 * a second place writing `family:instanceId` is a second spelling of it, and a
 * grant spelled differently is refused on write and dropped on read — silently,
 * in both directions.
 */
export interface GrantableConnector {
  grant: string;
  family: string;
  label: string;
  detail: string;
}

/**
 * The heading each instanced family gets in the connectors section, as an
 * i18n key.
 *
 * `agent` comes first because it continues the fixed list above: "Other agents"
 * is the last family a person reads, and "Your agents" is the same subject
 * narrowed to the ones they already have.
 */
export const INSTANCED_FAMILY_LABELS: Readonly<Record<string, string>> = {
  agent: 'agents.instancedFamily.agent',
  mcp: 'agents.instancedFamily.mcp',
  integration: 'agents.instancedFamily.integration',
};

/**
 * A team for `agent`, and deliberately NOT `AgentRobotIcon`.
 *
 * That glyph is `delegation` two lists up — finding, hiring and creating agents
 * — and this family is the other half of the same sentence: the agents you
 * already have. Drawing both with one mark would put the two switches an owner
 * has to tell apart under the same picture, which is the duplication #365
 * removed rather than a consistency to preserve.
 */
export const INSTANCED_FAMILY_ICONS: Readonly<Record<string, BloomIconComponent>> = {
  agent: RiTeamLine,
  mcp: ActionKeyIcon,
  integration: RiWindowLine,
};
