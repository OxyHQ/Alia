import { useMemo } from 'react';
import type {
  AgentPrimaryToolsState,
  PrimaryToolApp,
} from '@/features/agents/runtime/use-agent-primary-tools';
import { useTranslation } from '@/shared/i18n/use-translation';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';

interface ToolItem {
  value: string;
  label: string;
}

const ADD = 'add';

/**
 * "Herramientas principales": the app tools active from the first step of
 * every turn the agent leads, instead of waiting for the model to load them.
 * Offered from the apps the agent reaches — its owner's levels or its ceiling
 * for whoever uses it — and naming one grants nothing beyond that.
 *
 * A chosen tool no level covers any more is still listed, as not available, so
 * it can be taken away; until then it is simply absent from the agent's turns.
 *
 * Shown to whoever operates the agent; anybody else is answered 403.
 */
export function AgentPrimaryToolsSection({
  primaryTools: state,
}: {
  primaryTools: AgentPrimaryToolsState;
}) {
  const { t } = useTranslation();
  const { status, primaryTools, max, apps, toggle } = state;
  const offered = useMemo(() => offeredItems(apps), [apps]);
  if (status === 'hidden' || status === 'loading') return null;

  const labelOf = (key: string) =>
    offered.find((item) => item.value === key)?.label ??
    t('agents.primaryTools.unavailable', { tool: key });
  const addable = offered.filter((item) => !primaryTools.includes(item.value));

  return (
    <SettingsListGroup
      title={t('agents.primaryTools.title')}
      footer={
        status === 'failed'
          ? t('agents.primaryTools.loadFailed')
          : t('agents.primaryTools.footer', { max })
      }
    >
      {primaryTools.map((key) => (
        <SettingsListItem
          key={key}
          title={labelOf(key)}
          showChevron={false}
          rightElement={
            <Switch accessibilityLabel={labelOf(key)} checked onCheckedChange={() => toggle(key)} />
          }
        />
      ))}
      {status === 'ready' && addable.length > 0 && primaryTools.length < max ? (
        <SettingsListItem
          title={t('agents.primaryTools.add')}
          showChevron={false}
          rightElement={
            <Select size="sm" value={ADD} onValueChange={(next: string) => toggle(next)}>
              <SelectTrigger testID="primary-tools-add" label={t('agents.primaryTools.add')}>
                <SelectValue>{() => t('agents.primaryTools.choose')}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('agents.primaryTools.add')}
                items={addable}
                valueExtractor={(item: ToolItem) => item.value}
                renderItem={(item: ToolItem) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemIndicator />
                    <SelectItemText>{item.label}</SelectItemText>
                  </SelectItem>
                )}
              />
            </Select>
          }
        />
      ) : null}
    </SettingsListGroup>
  );
}

/** Every tool the agent reaches, as `App · tool` rows. */
function offeredItems(apps: readonly PrimaryToolApp[]): ToolItem[] {
  return apps.flatMap((app) =>
    app.tools.map((tool) => ({ value: tool.key, label: `${app.name} · ${tool.name}` })),
  );
}
