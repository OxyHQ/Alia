/**
 * AgentPermissionToggles — Granular access control toggles for agents.
 *
 * Allows agent creators to configure which capabilities their agent can use.
 * All permissions default to true (enabled) for backward compatibility.
 *
 * The component owns its `SettingsListGroup`, it does not go inside one:
 * `SettingsListGroup` draws its dividers from `React.Children.toArray`, which
 * sees a nested component as ONE child however many rows it renders.
 */

import React from 'react';
import { Switch } from '@/components/ui/switch';
import { Globe, MessageSquare } from 'lucide-react-native';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { ActionKeyIcon } from '@/components/ui/action-key-icon';
import { FilesIcon } from '@/components/ui/files-icon';
import { Robot2Icon } from '@/components/ui/robot-2-icon';
import { TerminalIcon } from '@/components/ui/terminal-icon';
import { useColorScheme } from '@/lib/useColorScheme';
import type { AgentPermissions } from '@/lib/stores/agents-store';

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  filesystem: true,
  network: true,
  shell: true,
  communications: true,
  mcp_servers: true,
  delegation: true,
};

interface PermissionToggleProps {
  /** Group heading, since the group belongs to this component. */
  title: string;
  footer?: string;
  permissions: AgentPermissions;
  onChange: (permissions: AgentPermissions) => void;
  disabled?: boolean;
}

/* `color`, not a NativeWind class: four of these six are an `Svg` whose fill can
   only be a value, and the row reads as one list only if all six take it the
   same way. Same call shape as the sibling rows in `security-section`. */
const PERMISSION_CONFIG: {
  key: keyof AgentPermissions;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
}[] = [
  {
    key: 'shell',
    label: 'Shell Access',
    description: 'Execute commands in a terminal container',
    icon: TerminalIcon,
  },
  {
    key: 'network',
    label: 'Web Browsing',
    description: 'Search the web, navigate pages, scrape content',
    icon: Globe,
  },
  {
    key: 'filesystem',
    label: 'File System',
    description: 'Read, write, and edit files in the workspace',
    icon: FilesIcon,
  },
  {
    key: 'communications',
    label: 'Communications',
    description: 'Send messages via Telegram, WhatsApp, Email',
    icon: MessageSquare,
  },
  {
    key: 'mcp_servers',
    label: 'MCP Tools',
    description: 'Access external MCP tool servers',
    icon: ActionKeyIcon,
  },
  {
    key: 'delegation',
    label: 'Agent Delegation',
    description: 'Hire and delegate tasks to other agents',
    icon: Robot2Icon,
  },
];

export function AgentPermissionToggles({
  title,
  footer,
  permissions,
  onChange,
  disabled,
}: PermissionToggleProps) {
  const { colors } = useColorScheme();

  return (
    <SettingsListGroup title={title} footer={footer}>
      {PERMISSION_CONFIG.map(({ key, label, description, icon: Icon }) => (
        <SettingsListItem
          key={key}
          icon={
            <Icon
              size={18}
              color={permissions[key] ? colors.foreground : colors.mutedForeground}
            />
          }
          title={label}
          description={description}
          disabled={disabled}
          showChevron={false}
          rightElement={
            <Switch
              value={permissions[key]}
              onValueChange={() => onChange({ ...permissions, [key]: !permissions[key] })}
              disabled={disabled}
            />
          }
        />
      ))}
    </SettingsListGroup>
  );
}
