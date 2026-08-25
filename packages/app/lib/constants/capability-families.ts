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
 * `mcp`, `oxy_service` and `integration` build their tool names from rows, so a
 * grant names the row: `mcp:<connectorId>`. They have no entry here, because a
 * switch labelled "MCP Tools" would be a grant over every connector the owner
 * will ever install. They are their own section, and its rows come from
 * `GET /agents/capability-connectors` — which also builds the grant STRING, so
 * this side never writes the separator.
 *
 * ## `color`, not a NativeWind class
 *
 * Six of these glyphs are an `Svg` whose fill can only be a value, and the rows
 * read as one list only if every icon takes it the same way. Same call shape
 * `agent-permission-toggles` established for its six.
 */

import {
  AppWindow,
  Brain,
  Clock,
  Globe,
  MessageSquare,
  Shapes,
} from 'lucide-react-native';
import { ActionKeyIcon } from '@/components/ui/action-key-icon';
import { FilesIcon } from '@/components/ui/files-icon';
import { Robot2Icon } from '@/components/ui/robot-2-icon';
import { TerminalIcon } from '@/components/ui/terminal-icon';

export type CapabilityIcon = React.ComponentType<{ size?: number; color?: string }>;

export interface CapabilityFamily {
  /** The grant string, exactly as it is stored and sent. */
  id: string;
  label: string;
  description: string;
  icon: CapabilityIcon;
}

/**
 * The nine families granted whole, in the order they are shown.
 *
 * Ordered by how much of the world the family reaches — reading the web, then
 * driving a browser and a shell, then the person's own files, memory and
 * messages, then acting through other agents. Not alphabetical: the ones with
 * the widest blast radius are the ones an owner should decide about first.
 *
 * Four of the glyphs are the Material Symbols the two lists this replaces
 * already carried, kept deliberately rather than re-chosen: `shell` keeps
 * `TerminalIcon`, `files` keeps `FilesIcon`, `delegation` keeps `Robot2Icon`,
 * and `mcp` — now an instanced family — keeps `ActionKeyIcon` below.
 */
export const CAPABILITY_FAMILIES: readonly CapabilityFamily[] = [
  {
    id: 'web',
    label: 'Web',
    description: 'Search the web, read pages and run deep research',
    icon: Globe,
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Drive a real browser — navigate, click, fill forms, screenshot',
    icon: AppWindow,
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Run commands in its own container',
    icon: TerminalIcon,
  },
  {
    id: 'files',
    label: 'Files',
    description: 'Read, write and edit files in its workspace',
    icon: FilesIcon,
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    description: 'Produce charts, tables, code blocks and downloadable files',
    icon: Shapes,
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Read and update what Alia remembers about you',
    icon: Brain,
  },
  {
    id: 'messaging',
    label: 'Messaging',
    description: 'Send and read messages on your Telegram and WhatsApp',
    icon: MessageSquare,
  },
  {
    id: 'automation',
    label: 'Automations',
    description: 'Create, edit and delete your scheduled triggers',
    icon: Clock,
  },
  {
    id: 'delegation',
    label: 'Other agents',
    description: 'Find, hire and create agents to work on its behalf',
    icon: Robot2Icon,
  },
];

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

/** The heading each instanced family gets in the connectors section. */
export const INSTANCED_FAMILY_LABELS: Readonly<Record<string, string>> = {
  mcp: 'Connectors',
  oxy_service: 'Oxy apps',
  integration: 'Integrations',
};

export const INSTANCED_FAMILY_ICONS: Readonly<Record<string, CapabilityIcon>> = {
  mcp: ActionKeyIcon,
  oxy_service: Shapes,
  integration: AppWindow,
};
