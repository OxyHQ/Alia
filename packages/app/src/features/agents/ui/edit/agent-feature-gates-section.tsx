import { useMemo } from 'react';
import type {
  AgentFeatureGatesState,
  GateableApp,
} from '@/features/agents/runtime/use-agent-feature-gates';
import type { AgentFeatureGate, GatedFeature } from '@/shared/contracts/agents';
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

/** The catalog key of each gateable feature's name. */
const FEATURE_LABELS: Record<GatedFeature, string> = {
  'attachments.documents': 'agents.featureGates.features.documents',
  'attachments.images': 'agents.featureGates.features.images',
  deep_research: 'agents.featureGates.features.deepResearch',
  'power_level.pro': 'agents.featureGates.features.pro',
  'power_level.ultra': 'agents.featureGates.features.ultra',
};

const NONE = 'none';

interface GateItem {
  value: string;
  label: string;
  gate: AgentFeatureGate | null;
}

const gateValue = (gate: AgentFeatureGate) => `${gate.app}/${gate.feature}`;

/**
 * "Funciones con requisitos": which of Alia's features an app's entitlement
 * unlocks for this agent (ADR 0020 §6) — each one free, or behind one feature
 * of one app's live catalogue (a Homiio+ plan, a Clarity plan). A person whose
 * app says the feature is locked is shown the app's upsell instead.
 *
 * A gate naming something no live catalogue offers any more (an app that has
 * not registered its catalogue yet, a feature it dropped) is still shown as
 * what it is, and stays locked for everybody until the app declares it.
 *
 * Shown to whoever operates the agent; anybody else is answered 403.
 */
export function AgentFeatureGatesSection({
  featureGates,
}: {
  featureGates: AgentFeatureGatesState;
}) {
  const { t } = useTranslation();
  const { status, features, gates, apps, setGate } = featureGates;
  const offered = useMemo(() => offeredItems(apps), [apps]);
  if (status === 'hidden' || status === 'loading') return null;

  return (
    <SettingsListGroup
      title={t('agents.featureGates.title')}
      footer={
        status === 'failed' ? t('agents.featureGates.loadFailed') : t('agents.featureGates.footer')
      }
    >
      {features.map((feature) => {
        const label = t(FEATURE_LABELS[feature]);
        const gate = gates[feature];
        const current = gate === undefined ? NONE : gateValue(gate);
        const items: GateItem[] = [
          { value: NONE, label: t('agents.featureGates.none'), gate: null },
          ...offered,
          ...(gate === undefined || offered.some((item) => item.value === current)
            ? []
            : [
                {
                  value: current,
                  label: t('agents.featureGates.unavailable', {
                    app: gate.app,
                    feature: gate.feature,
                  }),
                  gate,
                },
              ]),
        ];
        return (
          <SettingsListItem
            key={feature}
            title={label}
            showChevron={false}
            rightElement={
              <Select
                size="sm"
                value={current}
                onValueChange={(next: string) => {
                  const item = items.find((candidate) => candidate.value === next);
                  if (item) setGate(feature, item.gate);
                }}
              >
                <SelectTrigger
                  testID={`feature-gate-${feature}`}
                  label={t('agents.featureGates.gateLabel', { feature: label })}
                >
                  <SelectValue>
                    {() => items.find((item) => item.value === current)?.label ?? current}
                  </SelectValue>
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent
                  label={t('agents.featureGates.gateLabel', { feature: label })}
                  items={items}
                  valueExtractor={(item: GateItem) => item.value}
                  renderItem={(item: GateItem) => (
                    <SelectItem value={item.value} label={item.label}>
                      <SelectItemIndicator />
                      <SelectItemText>{item.label}</SelectItemText>
                    </SelectItem>
                  )}
                />
              </Select>
            }
          />
        );
      })}
    </SettingsListGroup>
  );
}

/** Every app feature a gate may name, as `App · feature` rows. */
function offeredItems(apps: readonly GateableApp[]): GateItem[] {
  return apps.flatMap((app) =>
    app.features.map((feature) => {
      const gate = { app: app.appId, feature: feature.key };
      return { value: gateValue(gate), label: `${app.name} · ${feature.key}`, gate };
    }),
  );
}
