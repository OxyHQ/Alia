import {
  routingPriorityFrom,
  withChannelToggled,
  withRoutingRuleAdded,
  withRoutingRuleEdited,
  withRoutingRuleRemoved,
} from '@/lib/agents/archetype-config';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { AgentArchetype, ArchetypeConfig } from '@/lib/types/agents';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { RiAddLine, RiCloseLine } from '@oxy.so/bloom/icons';
import { Label } from '@oxy.so/bloom/label';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

interface ConfigProps {
  config: ArchetypeConfig;
  onChange: (next: ArchetypeConfig) => void;
}

/** The configuration only some kinds of agent have, for the kind this one is. */
export function ArchetypeConfigSection({
  archetype,
  ...props
}: ConfigProps & { archetype: AgentArchetype }) {
  if (archetype === 'status_update') return <StatusUpdateConfig {...props} />;
  if (archetype === 'qa') return <QaConfig {...props} />;
  if (archetype === 'task_router') return <TaskRouterConfig {...props} />;
  return null;
}

const INBOUND_CHANNELS = [
  'email',
  'slack',
  'discord',
  'webhook',
  'github',
  'linear',
];

/**
 * A status-update agent's report: its template and whether it compares with
 * the last one — both read by the API when it writes the agent's prompt
 * (`lib/agent/archetype-prompts.ts`).
 *
 * There were three more controls here, and nothing on the server read any of
 * them (#608, rule 6). "Schedule" (daily/interval and a time) was stored in
 * `archetypeConfig.schedule` and never scheduled anything — recurring work is
 * an automation, which has its own real scheduler. "Delivery Channels" was
 * stored and never delivered to. "Escalation Timeout" on the router was stored
 * and never escalated.
 */
function StatusUpdateConfig({ config, onChange }: ConfigProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <Text variant="headline-semibold">{t('agents.archetype.reportConfig')}</Text>

      {/* Report Template */}
      <View className="gap-1.5">
        <Label>{t('agents.archetype.reportTemplate')}</Label>
        <Textarea
          value={config.reportTemplate || ''}
          onChangeText={(text) => onChange({ ...config, reportTemplate: text })}
          placeholder={t('agents.archetype.reportTemplatePlaceholder')}
          autoResize
          rows={6}
        />
      </View>

      {/* Compare with Previous */}
      <SettingsListGroup>
        <SettingsListItem
          title={t('agents.archetype.compareWithPrevious')}
          rightElement={
            <Switch
              accessibilityLabel={t('agents.archetype.compareWithPrevious')}
              value={config.compareWithPrevious || false}
              onValueChange={(val) =>
                onChange({ ...config, compareWithPrevious: val })
              }
            />
          }
        />
      </SettingsListGroup>
    </View>
  );
}

function QaConfig({ config, onChange }: ConfigProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <Text variant="headline-semibold">{t('agents.archetype.qaConfig')}</Text>

      {/* No "Knowledge Sources" picker. It wrote four hardcoded names
          into `archetypeConfig.knowledgeSources`, the third of the
          three capability vocabularies, and its only consumer spliced
          them into the Q&A prompt as PROSE. What an agent can actually
          reach is the Connectors section. */}

      {/* Cite Sources */}
      <SettingsListGroup>
        <SettingsListItem
          title={t('agents.archetype.citeSources')}
          rightElement={
            <Switch
              accessibilityLabel={t('agents.archetype.citeSources')}
              value={config.citeSources !== false}
              onValueChange={(val) => onChange({ ...config, citeSources: val })}
            />
          }
        />
      </SettingsListGroup>
    </View>
  );
}

function TaskRouterConfig({ config, onChange }: ConfigProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-4">
      <Text variant="headline-semibold">
        {t('agents.archetype.routingConfig')}
      </Text>

      {/* Inbound Channels */}
      <View className="gap-1.5">
        <Label>{t('agents.archetype.inboundChannels')}</Label>
        <View className="flex-row flex-wrap gap-2">
          {INBOUND_CHANNELS.map((channel) => (
            <Chip
              key={channel}
              size="xl"
              selected={(config.inboundChannels || []).includes(channel)}
              onPress={() =>
                onChange(withChannelToggled(config, 'inboundChannels', channel))
              }
            >
              {t(`agents.archetype.channel.${channel}`)}
            </Chip>
          ))}
        </View>
      </View>

      {/* Routing Rules */}
      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Label>{t('agents.archetype.routingRules')}</Label>
          <Button
            size="xs"
            tone="neutral"
            appearance="plain"
            icon={RiAddLine}
            accessibilityLabel={t('pages.agents.addRoutingRule')}
            onPress={() => onChange(withRoutingRuleAdded(config))}
          />
        </View>
        {(config.routingRules || []).map((rule, index) => (
          <Card key={index} appearance="subtle">
            <CardBody>
              <View className="gap-2 py-1">
                <Input
                  label={t('agents.archetype.ruleCondition')}
                  value={rule.condition}
                  onChangeText={(text) =>
                    onChange(
                      withRoutingRuleEdited(config, index, { condition: text }),
                    )
                  }
                  placeholder={t('agents.archetype.ruleCondition')}
                />
                <View className="flex-row items-center gap-2">
                  <SegmentedControl
                    label={t('agents.archetype.priority')}
                    type="radio"
                    size="sm"
                    value={rule.priority}
                    onValueChange={(val) =>
                      onChange(
                        withRoutingRuleEdited(config, index, {
                          priority: routingPriorityFrom(val),
                        }),
                      )
                    }
                  >
                    <SegmentedControlItem value="low">
                      <SegmentedControlItemText>
                        {t('agents.archetype.priorityLow')}
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="medium">
                      <SegmentedControlItemText>
                        {t('agents.archetype.priorityMedium')}
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="high">
                      <SegmentedControlItemText>
                        {t('agents.archetype.priorityHigh')}
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="urgent">
                      <SegmentedControlItemText>
                        {t('agents.archetype.priorityUrgent')}
                      </SegmentedControlItemText>
                    </SegmentedControlItem>
                  </SegmentedControl>
                  <View className="flex-1" />
                  <Button
                    size="xs"
                    tone="neutral"
                    appearance="plain"
                    icon={RiCloseLine}
                    accessibilityLabel={t('pages.agents.removeRoutingRule')}
                    onPress={() =>
                      onChange(withRoutingRuleRemoved(config, index))
                    }
                  />
                </View>
                <Input
                  label={t('agents.archetype.routeTo')}
                  value={rule.assignTo?.name || ''}
                  onChangeText={(text) =>
                    onChange(
                      withRoutingRuleEdited(config, index, {
                        assignTo: { ...rule.assignTo, name: text },
                      }),
                    )
                  }
                  placeholder={t('agents.archetype.routeTo')}
                />
              </View>
            </CardBody>
          </Card>
        ))}
      </View>
    </View>
  );
}
