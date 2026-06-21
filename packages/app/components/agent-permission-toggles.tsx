/**
 * AgentPermissionToggles — Granular access control toggles for agents.
 *
 * Allows agent creators to configure which capabilities their agent can use.
 * All permissions default to true (enabled) for backward compatibility.
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Terminal, Globe, FileEdit, MessageSquare, Plug, Users } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';

export interface AgentPermissions {
  filesystem: boolean;
  network: boolean;
  shell: boolean;
  communications: boolean;
  mcp_servers: boolean;
  delegation: boolean;
}

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  filesystem: true,
  network: true,
  shell: true,
  communications: true,
  mcp_servers: true,
  delegation: true,
};

interface PermissionToggleProps {
  permissions: AgentPermissions;
  onChange: (permissions: AgentPermissions) => void;
  disabled?: boolean;
}

const PERMISSION_CONFIG = [
  {
    key: 'shell' as const,
    label: 'Shell Access',
    description: 'Execute commands in a terminal container',
    icon: Terminal,
  },
  {
    key: 'network' as const,
    label: 'Web Browsing',
    description: 'Search the web, navigate pages, scrape content',
    icon: Globe,
  },
  {
    key: 'filesystem' as const,
    label: 'File System',
    description: 'Read, write, and edit files in the workspace',
    icon: FileEdit,
  },
  {
    key: 'communications' as const,
    label: 'Communications',
    description: 'Send messages via Telegram, WhatsApp, Email',
    icon: MessageSquare,
  },
  {
    key: 'mcp_servers' as const,
    label: 'MCP Tools',
    description: 'Access external MCP tool servers',
    icon: Plug,
  },
  {
    key: 'delegation' as const,
    label: 'Agent Delegation',
    description: 'Hire and delegate tasks to other agents',
    icon: Users,
  },
];

export function AgentPermissionToggles({ permissions, onChange, disabled }: PermissionToggleProps) {
  const { isDarkColorScheme } = useColorScheme();

  const handleToggle = (key: keyof AgentPermissions) => {
    onChange({ ...permissions, [key]: !permissions[key] });
  };

  return (
    <View className="gap-1">
      {PERMISSION_CONFIG.map(({ key, label, description, icon: Icon }) => (
        <View
          key={key}
          className="flex-row items-center justify-between py-3 px-1"
        >
          <View className="flex-row items-center gap-3 flex-1 mr-3">
            <Icon
              size={18}
              className={permissions[key] ? 'text-foreground' : 'text-muted-foreground'}
            />
            <View className="flex-1">
              <Label className="text-sm font-medium">{label}</Label>
              <Text className="text-xs text-muted-foreground">{description}</Text>
            </View>
          </View>
          <Switch
            checked={permissions[key]}
            onCheckedChange={() => handleToggle(key)}
            disabled={disabled}
          />
        </View>
      ))}
    </View>
  );
}
