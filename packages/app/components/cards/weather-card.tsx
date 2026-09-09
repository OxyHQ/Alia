import { useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { cn } from "@/lib/utils";
import { AreaChart, areaGeometry } from "@/components/cards/area-chart";
import { CardSurface } from "@/components/cards/card-surface";

/**
 * The weather, drawn from the snapshot stored with the message.
 *
 * Everything it can show came in the tool result, so selecting a day or
 * switching the unit costs no request and a thread reopened next month shows
 * the forecast it was answered with. The counterpart that produces this is
 * `packages/api/src/lib/tools/weather.ts`.
 *
 * Which day is selected is view state and deliberately not persisted: nobody
 * reopens a month-old chat expecting Thursday still to be highlighted.
 */

export interface WeatherCardData {
  place: string;
  timezone: string;
  current: { temperature: number; humidity: number; windSpeed: number; condition: string };
  hourly: { time: string; temperature: number; precipitationChance: number }[];
  daily: { date: string; condition: string; high: number; low: number }[];
}

/** Celsius on the wire; what the reader sees is their choice, not the answer's. */
type Unit = "C" | "F";
const toUnit = (celsius: number, unit: Unit) =>
  unit === "C" ? celsius : celsius * 9 / 5 + 32;
const degrees = (celsius: number, unit: Unit) => `${Math.round(toUnit(celsius, unit))}°`;

const CONDITION_GLYPH: Record<string, string> = {
  clear: "☀️",
  "partly-cloudy": "⛅",
  cloudy: "☁️",
  fog: "🌫️",
  drizzle: "🌦️",
  rain: "🌧️",
  showers: "🌦️",
  snow: "❄️",
  "snow-showers": "🌨️",
  thunderstorm: "⛈️",
};

const CHART_HEIGHT = 96;
const CHART_WIDTH = 320;
const CHART_PADDING = 6;

/** The day's temperature as an area. No axis: the day strip below says the scale. */
function HourlyChart({ points, unit, tint }: { points: number[]; unit: Unit; tint: string }) {
  const geometry = areaGeometry(points.map((c) => toUnit(c, unit)), {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    padding: CHART_PADDING,
  });
  if (!geometry) return null;

  return <AreaChart geometry={geometry} tint={tint} width={CHART_WIDTH} height={CHART_HEIGHT} />;
}

export function WeatherCard({ data }: { data: WeatherCardData }) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const [unit, setUnit] = useState<Unit>("C");
  const [selectedDay, setSelectedDay] = useState(0);

  const day = data.daily[selectedDay];
  const hoursOfDay = day
    ? data.hourly.filter((h) => h.time.startsWith(day.date))
    : data.hourly;

  return (
    <CardSurface>
      <View className="flex-row items-start justify-between">
        <View className="flex-1">
          <Text className="text-sm text-muted-foreground">{data.place}</Text>
          <Text className="mt-1 text-4xl font-medium text-foreground">
            {degrees(data.current.temperature, unit)}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("weather.toggleUnit")}
          className="flex-row items-center gap-1 rounded-full px-2 py-0.5 active:bg-muted"
          onPress={() => setUnit((u) => (u === "C" ? "F" : "C"))}
        >
          <Text className={cn("text-sm", unit === "C" ? "font-semibold text-foreground" : "text-muted-foreground")}>C</Text>
          <Text className="text-sm text-muted-foreground">/</Text>
          <Text className={cn("text-sm", unit === "F" ? "font-semibold text-foreground" : "text-muted-foreground")}>F</Text>
        </Pressable>
      </View>

      <Text className="mt-1 text-sm text-muted-foreground">
        {t(`weather.condition.${data.current.condition}`)}
      </Text>

      <HourlyChart
        points={hoursOfDay.map((h) => h.temperature)}
        unit={unit}
        tint={colors.primary}
      />

      {/* Horizontal scroll, not arrows: this has to work under a thumb. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-1 mt-1"
        contentContainerClassName="gap-1 px-1"
      >
        {data.daily.map((d, i) => (
          <Pressable
            key={d.date}
            accessibilityRole="button"
            accessibilityState={{ selected: i === selectedDay }}
            className={cn(
              "min-w-[64px] items-center gap-1 rounded-lg px-2 py-2",
              i === selectedDay && "bg-muted",
            )}
            onPress={() => setSelectedDay(i)}
          >
            <Text className="text-sm font-medium text-foreground">
              {new Date(d.date).toLocaleDateString(locale, { weekday: "short" })}
            </Text>
            <Text className="text-base">{CONDITION_GLYPH[d.condition] ?? "•"}</Text>
            <Text className="text-sm font-semibold text-foreground">{degrees(d.high, unit)}</Text>
            <Text className="text-sm text-muted-foreground">{degrees(d.low, unit)}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </CardSurface>
  );
}
