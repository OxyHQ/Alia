/**
 * AgentCapabilityToggles — ONE list of what an agent may reach.
 *
 * It replaces `AgentPermissionToggles` and the `AGENT_TOOLS` list that sat
 * above it in the agent editor. Those were two lists for one idea, and they
 * contradicted each other: "Web Browsing" appeared in both, "Code Execution"
 * and "Shell Access" were the same thing under two names sharing one icon, and
 * "File Management" and "File System" described each other. An owner had to set
 * both to mean one thing, and neither reached the tool assembler in the way its
 * label promised.
 *
 * ## An unset switch DENIES
 *
 * `permissions` defaulted every switch to on and meant "allowed" when unset, so
 * an agent nobody had configured could reach everything its owner could. This
 * list starts empty. That is a deliberate reversal, argued in
 * `packages/api/src/domain/capability-grants.ts`, and the footer says so on
 * screen rather than leaving it to be discovered.
 *
 * The component owns its `SettingsListGroup`, it does not go inside one:
 * `SettingsListGroup` draws its dividers from `React.Children.toArray`, which
 * sees a nested component as ONE child however many rows it renders.
 */

import React from 'react';
import { Switch } from '@/components/ui/switch';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useColorScheme } from '@/lib/useColorScheme';
import { CAPABILITY_FAMILIES } from '@/lib/constants/capability-families';

interface AgentCapabilityTogglesProps {
  /** Group heading, since the group belongs to this component. */
  title: string;
  footer?: string;
  /** Every grant the agent holds, families and connectors alike. */
  grants: string[];
  onChange: (grants: string[]) => void;
  disabled?: boolean;
}

export function AgentCapabilityToggles({
  title,
  footer,
  grants,
  onChange,
  disabled,
}: AgentCapabilityTogglesProps) {
  const { colors } = useColorScheme();

  /**
   * Toggling a FAMILY leaves every connector grant untouched.
   *
   * The list holds both shapes — `web` and `mcp:abc` — and this component only
   * renders the families, so a naive "replace with the checked families" would
   * silently revoke every connector the owner had granted in the section below.
   */
  const toggle = (id: string): void => {
    onChange(grants.includes(id) ? grants.filter((grant) => grant !== id) : [...grants, id]);
  };

  return (
    <SettingsListGroup title={title} footer={footer}>
      {CAPABILITY_FAMILIES.map(({ id, label, description, icon: Icon }) => {
        const granted = grants.includes(id);
        return (
          <SettingsListItem
            key={id}
            icon={<Icon size={18} color={granted ? colors.foreground : colors.mutedForeground} />}
            title={label}
            description={description}
            disabled={disabled}
            showChevron={false}
            rightElement={
              <Switch value={granted} onValueChange={() => toggle(id)} disabled={disabled} />
            }
          />
        );
      })}
    </SettingsListGroup>
  );
}
