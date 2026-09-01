/**
 * AgentConnectorGrants — the rows an agent may reach, ONE AT A TIME.
 *
 * Three capability families are granted a row at a time — MCP connectors,
 * OAuth integrations and the owner's own agents — so a grant names the row rather than the family (`mcp:<id>`,
 * `agent:<id>`). They get their own section for that reason: a single switch
 * labelled "MCP Tools" would be a grant over every connector the owner will
 * ever install, which is exactly what an agent inheriting all of its owner's
 * connectors was.
 *
 * The rows come from `GET /agents/capability-connectors`, which is the only
 * place that can enumerate all four, and which hands over the grant STRING
 * already assembled — so this file never writes `family:instanceId` itself.
 *
 * ## A row that grants the WHOLE family, and what it does to the others
 *
 * One family — `agent` — also offers "all your active agents", and the server
 * sends it as an ordinary row whose `grant` IS the family name. Nothing here is
 * special-cased for it: a row whose grant equals its family covers the rest of
 * the group, so while it is on, the individual switches read as granted and are
 * disabled. Leaving them live would offer an owner a switch that changes
 * nothing, which is the inert toggle this vocabulary exists to stop.
 *
 * An owner with no connectors sees nothing here rather than an empty group.
 */

import React from 'react';
import { Switch } from '@/components/ui/switch';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useColorScheme } from '@/lib/useColorScheme';
import {
  INSTANCED_FAMILY_ICONS,
  INSTANCED_FAMILY_LABELS,
  type GrantableConnector,
} from '@/lib/constants/capability-families';

interface AgentConnectorGrantsProps {
  connectors: GrantableConnector[];
  /** Every grant the agent holds, families and connectors alike. */
  grants: string[];
  onChange: (grants: string[]) => void;
  disabled?: boolean;
}

export function AgentConnectorGrants({
  connectors,
  grants,
  onChange,
  disabled,
}: AgentConnectorGrantsProps) {
  const { colors } = useColorScheme();

  /**
   * Grouped by family, in the order the families are declared.
   *
   * Derived on render rather than memoised: it is a single pass over a list
   * that is a handful of rows long, and a memo keyed on an array identity would
   * be a stale read the moment the parent rebuilds it.
   */
  const families = Object.keys(INSTANCED_FAMILY_LABELS).flatMap((family) => {
    const rows = connectors.filter((connector) => connector.family === family);
    return rows.length === 0 ? [] : [{ family, rows }];
  });

  return (
    <>
      {families.map(({ family, rows }) => {
        const Icon = INSTANCED_FAMILY_ICONS[family];
        return (
          <SettingsListGroup key={family} title={INSTANCED_FAMILY_LABELS[family]}>
            {rows.map((connector) => {
              // Covered by the family-wide row above, if the group has one and
              // it is on. Comparing two fields the server sent, never parsing
              // the grant.
              const subsumed = connector.grant !== family && grants.includes(family);
              const granted = subsumed || grants.includes(connector.grant);
              return (
                <SettingsListItem
                  key={connector.grant}
                  icon={
                    <Icon
                      size={18}
                      color={granted ? colors.foreground : colors.mutedForeground}
                    />
                  }
                  title={connector.label}
                  description={connector.detail}
                  disabled={disabled || subsumed}
                  showChevron={false}
                  rightElement={
                    <Switch
                      value={granted}
                      onValueChange={() =>
                        onChange(
                          granted
                            ? grants.filter((grant) => grant !== connector.grant)
                            : [...grants, connector.grant],
                        )
                      }
                      disabled={disabled || subsumed}
                    />
                  }
                />
              );
            })}
          </SettingsListGroup>
        );
      })}
    </>
  );
}
