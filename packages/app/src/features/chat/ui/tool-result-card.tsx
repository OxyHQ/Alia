import { triggerLabel } from '@/shared/contracts/automations';
import {
  degrees,
  faircoinChart,
  forecastWeekday,
  formatPrice,
  marketChart,
  type FairCoinCardData,
  type MarketCardData,
  type PriceChart,
  type ScheduledTaskCardData,
  type TemperatureUnit,
  type ToolCard,
  type WeatherCardData,
} from '@/features/chat/model/tool-cards';
import { useTranslation } from '@/shared/i18n/use-translation';
import { AiChatMessageLine } from '@oxy.so/bloom/ai-chat';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody, CardHeader } from '@oxy.so/bloom/card';
import { LineChartCard } from '@oxy.so/bloom/chart-cards';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCalendarScheduleLine } from '@oxy.so/bloom/icons/RiCalendarScheduleLine';
import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import { RiDropLine } from '@oxy.so/bloom/icons/RiDropLine';
import { RiSnowflakeLine } from '@oxy.so/bloom/icons/RiSnowflakeLine';
import { RiSunFoggyLine } from '@oxy.so/bloom/icons/RiSunFoggyLine';
import { RiSunLine } from '@oxy.so/bloom/icons/RiSunLine';
import { Item } from '@oxy.so/bloom/item';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

/**
 * A tool result drawn inside the assistant turn, each card one block line of
 * the reply (`AiChatMessageLine block`) so it reveals with the turn.
 *
 *  - market, FairCoin → Bloom `LineChartCard`, one range per stored period
 *  - weather          → `Card` with an `IconCircle` and the forecast as `Item`s
 *  - scheduled task   → `Card` with an `Item` that opens the automation
 */
export function ToolResultCard({ card }: { card: ToolCard }) {
  switch (card.type) {
    case 'market':
      return <MarketResult data={card.data} />;
    case 'faircoin':
      return <FairCoinResult data={card.data} />;
    case 'weather':
      return <WeatherResult data={card.data} />;
    case 'scheduled-task':
      return <ScheduledTaskResult data={card.data} />;
  }
}

function PriceLineChart({ chart }: { chart: PriceChart }) {
  return (
    <LineChartCard
      title={chart.title}
      ranges={chart.ranges}
      defaultRange={chart.defaultRange}
      rangesLabel={chart.title}
      format={chart.format}
      formatAxisValue={chart.formatAxisValue}
      accessibilityLabel={chart.title}
    />
  );
}

function Notes({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line) => (
        <AiChatMessageLine key={line} tone="secondary">
          {line}
        </AiChatMessageLine>
      ))}
    </>
  );
}

/** A quote with no line to draw still says its price, in words. */
function PriceInWords({ title, price, hint }: { title: string; price: string; hint?: string }) {
  return (
    <Card>
      <CardBody>
        <Muted>{title}</Muted>
        <Text variant="title-1-medium">{price}</Text>
        {hint === undefined ? null : <Muted>{hint}</Muted>}
      </CardBody>
    </Card>
  );
}

function MarketResult({ data }: { data: MarketCardData }) {
  const { t, locale } = useTranslation();
  const chart = marketChart(data, t, locale);
  return (
    <>
      <AiChatMessageLine block>
        {chart !== null ? (
          <PriceLineChart chart={chart} />
        ) : (
          <PriceInWords
            title={`${data.name} · ${data.symbol}`}
            price={
              typeof data.price === 'number'
                ? formatPrice(data.price, data.currency, locale)
                : t('market.noPrice')
            }
            hint={t('market.noChart')}
          />
        )}
      </AiChatMessageLine>
      {chart === null ? null : <Notes lines={chart.notes} />}
    </>
  );
}

function FairCoinResult({ data }: { data: FairCoinCardData }) {
  const { t, locale } = useTranslation();
  const { chart, notes } = faircoinChart(data, t, locale);
  return (
    <>
      <AiChatMessageLine block>
        {chart !== null ? (
          <PriceLineChart chart={chart} />
        ) : (
          <PriceInWords
            title={`${t('faircoin.name')} · ${t('faircoin.symbol')}`}
            price={
              typeof data.price === 'number' && Number.isFinite(data.price)
                ? formatPrice(data.price, 'USD', locale)
                : t('faircoin.noPrice')
            }
          />
        )}
      </AiChatMessageLine>
      <Notes lines={notes} />
    </>
  );
}

const CONDITION_ICON: Record<string, typeof RiSunLine> = {
  clear: RiSunLine,
  'partly-cloudy': RiSunFoggyLine,
  cloudy: RiCloudLine,
  fog: RiSunFoggyLine,
  drizzle: RiDropLine,
  rain: RiDropLine,
  showers: RiDropLine,
  snow: RiSnowflakeLine,
  'snow-showers': RiSnowflakeLine,
  thunderstorm: RiCloudLine,
};

const conditionIcon = (condition: string) => CONDITION_ICON[condition] ?? RiCloudLine;

function WeatherResult({ data }: { data: WeatherCardData }) {
  const { t, locale } = useTranslation();
  /** View state, deliberately not persisted: nobody reopens a chat for its unit. */
  const [unit, setUnit] = useState<TemperatureUnit>('C');

  return (
    <AiChatMessageLine block>
      <Card>
        <CardHeader>
          <View className="flex-row items-center gap-3">
            <IconCircle icon={conditionIcon(data.current.condition)} size="lg" />
            <View className="min-w-0 flex-1">
              <Muted>{data.place}</Muted>
              <Text variant="title-1-medium">{degrees(data.current.temperature, unit)}</Text>
              <Muted>{t(`weather.condition.${data.current.condition}`)}</Muted>
            </View>
            <SegmentedControl
              label={t('weather.toggleUnit')}
              type="radio"
              value={unit}
              onValueChange={(next: string) => setUnit(next === 'F' ? 'F' : 'C')}
            >
              <SegmentedControlItem value="C">
                <SegmentedControlItemText>°C</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="F">
                <SegmentedControlItemText>°F</SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </View>
        </CardHeader>
        {data.daily.length === 0 ? null : (
          <CardBody>
            {data.daily.map((day) => {
              const Icon = conditionIcon(day.condition);
              return (
                <Item
                  key={day.date}
                  density="compact"
                  role="listitem"
                  leading={<Icon size="sm" />}
                  title={forecastWeekday(day.date, locale)}
                  subtitle={t(`weather.condition.${day.condition}`)}
                  trailing={
                    <Text variant="body-medium">
                      {`${degrees(day.high, unit)} / ${degrees(day.low, unit)}`}
                    </Text>
                  }
                />
              );
            })}
          </CardBody>
        )}
      </Card>
    </AiChatMessageLine>
  );
}

function ScheduledTaskResult({ data }: { data: ScheduledTaskCardData }) {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <AiChatMessageLine block>
      <Card>
        <Item
          leading={<RiCalendarScheduleLine size="md" />}
          title={data.objective}
          subtitle={triggerLabel(data.trigger, t)}
          trailing={
            <View className="flex-row items-center gap-2">
              <Badge
                variant="subtle"
                color={data.enabled ? 'success' : 'default'}
                content={t(data.enabled ? 'chat.toolCard.scheduled' : 'chat.toolCard.paused')}
              />
              <RiArrowRightSLine size="sm" />
            </View>
          }
          accessibilityRole="link"
          accessibilityLabel={t('chat.toolCard.openTask', { objective: data.objective })}
          onPress={() =>
            router.push({ pathname: '/(app)/automations/[id]', params: { id: data.id } })
          }
        />
      </Card>
    </AiChatMessageLine>
  );
}
