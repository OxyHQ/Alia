import {
  escalationMinutesFrom,
  routingPriorityFrom,
  scheduleTypeFrom,
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

const DELIVERY_CHANNELS = ['in_app', 'telegram', 'discord', 'slack', 'email'];
const INBOUND_CHANNELS = [
  'email',
  'slack',
  'discord',
  'webhook',
  'github',
  'linear',
];

function StatusUpdateConfig({ config, onChange }: ConfigProps) {
  return (
    <View className="gap-4">
      <Text variant="headline-semibold">Report Configuration</Text>

      {/* Report Template */}
      <View className="gap-1.5">
        <Label>Report Template</Label>
        <Textarea
          value={config.reportTemplate || ''}
          onChangeText={(text) => onChange({ ...config, reportTemplate: text })}
          placeholder="## Daily Standup\n### What happened\n### Key metrics\n### Action items"
          autoResize
          rows={6}
        />
      </View>

      {/* Schedule */}
      <View className="gap-1.5">
        <Label>Schedule</Label>
        <View className="self-start">
          <SegmentedControl
            label="Schedule"
            type="radio"
            value={config.schedule?.type || 'daily'}
            onValueChange={(val) =>
              onChange({
                ...config,
                schedule: { ...config.schedule, type: scheduleTypeFrom(val) },
              })
            }
          >
            <SegmentedControlItem value="daily">
              <SegmentedControlItemText>Daily</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="interval">
              <SegmentedControlItemText>Interval</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>
        {(config.schedule?.type || 'daily') === 'daily' && (
          <Input
            label="09:00"
            value={config.schedule?.time || '09:00'}
            onChangeText={(text) =>
              onChange({
                ...config,
                schedule: {
                  ...config.schedule,
                  type: config.schedule?.type ?? 'daily',
                  time: text,
                },
              })
            }
            placeholder="09:00"
          />
        )}
      </View>

      {/* Delivery Channels */}
      <View className="gap-1.5">
        <Label>Delivery Channels</Label>
        <View className="flex-row flex-wrap gap-2">
          {DELIVERY_CHANNELS.map((channel) => (
            <Chip
              key={channel}
              size="xl"
              selected={(config.deliveryChannels || []).includes(channel)}
              onPress={() =>
                onChange(withChannelToggled(config, 'deliveryChannels', channel))
              }
            >
              {channel.replace('_', ' ')}
            </Chip>
          ))}
        </View>
      </View>

      {/* Compare with Previous */}
      <SettingsListGroup>
        <SettingsListItem
          title="Compare with previous report"
          rightElement={
            <Switch
              accessibilityLabel="Compare with previous report"
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
  return (
    <View className="gap-4">
      <Text variant="headline-semibold">Q&A Configuration</Text>

      {/* No "Knowledge Sources" picker. It wrote four hardcoded names
          into `archetypeConfig.knowledgeSources`, the third of the
          three capability vocabularies, and its only consumer spliced
          them into the Q&A prompt as PROSE. What an agent can actually
          reach is the Connectors section. */}

      {/* Cite Sources */}
      <SettingsListGroup>
        <SettingsListItem
          title="Cite sources in answers"
          rightElement={
            <Switch
              accessibilityLabel="Cite sources in answers"
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
      <Text variant="headline-semibold">Routing Configuration</Text>

      {/* Inbound Channels */}
      <View className="gap-1.5">
        <Label>Inbound Channels</Label>
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
              {channel}
            </Chip>
          ))}
        </View>
      </View>

      {/* Routing Rules */}
      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Label>Routing Rules</Label>
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
                  label="When the task is about..."
                  value={rule.condition}
                  onChangeText={(text) =>
                    onChange(
                      withRoutingRuleEdited(config, index, { condition: text }),
                    )
                  }
                  placeholder="When the task is about..."
                />
                <View className="flex-row items-center gap-2">
                  <SegmentedControl
                    label="Priority"
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
                      <SegmentedControlItemText>Low</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="medium">
                      <SegmentedControlItemText>Med</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="high">
                      <SegmentedControlItemText>High</SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="urgent">
                      <SegmentedControlItemText>
                        Urgent
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
                  label="Route to (name)"
                  value={rule.assignTo?.name || ''}
                  onChangeText={(text) =>
                    onChange(
                      withRoutingRuleEdited(config, index, {
                        assignTo: { ...rule.assignTo, name: text },
                      }),
                    )
                  }
                  placeholder="Route to (name)"
                />
              </View>
            </CardBody>
          </Card>
        ))}
      </View>

      {/* Escalation Timeout */}
      <View className="gap-1.5">
        <Label>Escalation Timeout (minutes)</Label>
        <Input
          label="60"
          value={String(config.escalationTimeoutMinutes || '')}
          onChangeText={(text) =>
            onChange({
              ...config,
              escalationTimeoutMinutes: escalationMinutesFrom(text),
            })
          }
          placeholder="60"
          keyboardType="number-pad"
        />
      </View>
    </View>
  );
}
