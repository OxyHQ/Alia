import { useMemo, useState } from "react";
import { View, Pressable } from "react-native";
import { Line, Text as SvgText } from "react-native-svg";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { cn } from "@/lib/utils";
import { AreaChart, areaGeometry } from "@/components/cards/area-chart";
import { CardSurface } from "@/components/cards/card-surface";

/**
 * A crypto quote, drawn from the snapshot stored with the message.
 *
 * Every range the control offers is already in the tool result, so changing
 * range costs no request and a thread reopened next month shows the price the
 * question was answered with rather than today's. The counterpart that produces
 * this is `packages/api/src/lib/tools/market.ts`, which spends two requests to
 * make that true.
 *
 * Which range is selected is view state and deliberately not persisted: nobody
 * reopens a month-old chat expecting 6M still to be highlighted.
 */

/** `[msSinceEpoch, price]`, exactly as the tool stored it. */
export type MarketPoint = [number, number];

export interface MarketCardData {
  id: string;
  name: string;
  symbol: string;
  currency: string;
  price?: number;
  changePct?: number;
  changeAbs?: number;
  marketCap?: number;
  volume24h?: number;
  /**
   * Optional per key even though the tool writes them all: this comes off the
   * wire, and a row stored by an older version of the tool is not a crash.
   */
  series: Record<string, MarketPoint[] | undefined>;
}

/** The order the control offers, not the order the tool happens to store. */
const RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
type Range = (typeof RANGES)[number];

const CHART_HEIGHT = 140;
const CHART_WIDTH = 320;
/** Room on the right for the axis labels, which sit beside the plot, not on it. */
const AXIS_GUTTER = 46;
const PLOT_WIDTH = CHART_WIDTH - AXIS_GUTTER;
const CHART_PADDING = 8;
const GRID_LINES = 4;

/**
 * ISO 4217 is three letters and `Intl` throws a `RangeError` on anything that
 * is not. The currency arrives from whatever the reader typed, so a typo would
 * take the whole card down instead of just the symbol in front of the price.
 */
const isCurrencyCode = (code: string) => /^[A-Za-z]{3}$/.test(code);

/** A coin worth 0.000023 is not "0.00", and one worth 60000 is not "60000.000000". */
const priceDigits = (value: number) => (Math.abs(value) < 1 ? 6 : 2);

function formatPrice(value: number, currency: string, locale: string) {
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: 2,
    maximumFractionDigits: priceDigits(value),
  };
  if (!isCurrencyCode(currency)) {
    return `${value.toLocaleString(locale, options)} ${currency.toUpperCase()}`;
  }
  return value.toLocaleString(locale, {
    ...options,
    style: "currency",
    currency: currency.toUpperCase(),
  });
}

/**
 * Market caps run to twelve digits, and the scale names are not a suffix that
 * can be appended in one language and reused in the next — Spanish "billón" is
 * 10¹², not 10⁹ — so the whole shortened number goes through a translation.
 */
const SCALES = [
  { at: 1e12, key: "trillion" },
  { at: 1e9, key: "billion" },
  { at: 1e6, key: "million" },
  { at: 1e3, key: "thousand" },
] as const;

function formatCompact(
  value: number,
  currency: string,
  locale: string,
  t: (key: string, params?: Record<string, string>) => string,
) {
  const scale = SCALES.find((s) => Math.abs(value) >= s.at);
  if (!scale) return formatPrice(value, currency, locale);
  const short = t(`market.scale.${scale.key}`, {
    value: (value / scale.at).toLocaleString(locale, { maximumFractionDigits: 2 }),
  });
  return `${short} ${currency.toUpperCase()}`;
}

/** The axis labels a price scale, not a currency: no symbol, and no decimals it does not need. */
const formatAxis = (value: number, locale: string) =>
  value.toLocaleString(locale, {
    maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 6,
  });

export function MarketCard({ data }: { data: MarketCardData }) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();

  // A range with one point cannot be drawn and a range with none was never
  // stored, so neither is offered. YTD in the first days of January is the case
  // this really covers, and it is a real one.
  const ranges = useMemo(
    () => RANGES.filter((r) => (data.series[r]?.length ?? 0) >= 2),
    [data.series],
  );
  const [range, setRange] = useState<Range>(() =>
    ranges.includes("1D") ? "1D" : (ranges[0] ?? "1D"),
  );

  const geometry = useMemo(() => {
    const points = data.series[range] ?? [];
    return areaGeometry(points.map(([, price]) => price), {
      width: PLOT_WIDTH,
      height: CHART_HEIGHT,
      padding: CHART_PADDING,
    });
  }, [data.series, range]);

  const change = useMemo(() => {
    // 1D reports the quote's own 24h change rather than the ends of the
    // intraday series: that series starts at whatever moment the window opened,
    // which is neither midnight nor exactly a day ago, and the tool already
    // shipped the absolute change so that two clients could not round it two
    // different ways.
    if (range === "1D" && data.changePct !== undefined) {
      return { pct: data.changePct, abs: data.changeAbs };
    }
    const points = data.series[range];
    if (!points || points.length < 2) return null;
    const first = points[0][1];
    const last = points[points.length - 1][1];
    // Something that was worth nothing has no percentage change from nothing.
    return {
      pct: first === 0 ? undefined : ((last - first) / first) * 100,
      abs: last - first,
    };
  }, [data.changeAbs, data.changePct, data.series, range]);

  const direction = change === null ? null : (change.pct ?? change.abs ?? 0) >= 0 ? "up" : "down";
  // Bloom resolves these per colour scheme, so the pair reads in light and in
  // dark without a second set of values. There is no `success` utility class to
  // match `text-destructive`, and colouring one half of a semantic pair with a
  // class and the other with a style is how the two drift apart.
  const semantic = direction === "down" ? colors.error : colors.success;
  const tint = direction === null ? colors.primary : semantic;

  const gridValues = useMemo(() => {
    if (!geometry) return [];
    // A flat range has one price, and four labels all reading it, stacked on
    // one line, is worse than saying it once.
    if (geometry.max === geometry.min) return [geometry.min];
    return Array.from(
      { length: GRID_LINES },
      (_, i) => geometry.min + ((geometry.max - geometry.min) * i) / (GRID_LINES - 1),
    );
  }, [geometry]);

  const stats = useMemo(() => {
    const intraday = (data.series["1D"] ?? []).map(([, price]) => price);
    const day = intraday.length
      ? { open: intraday[0], high: Math.max(...intraday), low: Math.min(...intraday) }
      : null;
    const entries: { key: string; value: string }[] = [];
    // The day's open, high and low are the intraday series read three ways —
    // the tool does not send them separately and should not spend a request on
    // what it already fetched.
    if (day) {
      entries.push({ key: "open", value: formatPrice(day.open, data.currency, locale) });
      entries.push({ key: "dayHigh", value: formatPrice(day.high, data.currency, locale) });
      entries.push({ key: "dayLow", value: formatPrice(day.low, data.currency, locale) });
    }
    if (data.volume24h !== undefined) {
      entries.push({ key: "volume", value: formatCompact(data.volume24h, data.currency, locale, t) });
    }
    if (data.marketCap !== undefined) {
      entries.push({ key: "marketCap", value: formatCompact(data.marketCap, data.currency, locale, t) });
    }
    return entries;
  }, [data.currency, data.marketCap, data.series, data.volume24h, locale, t]);

  const sign = direction === "up" ? "+" : "-";
  const deltaParts = change
    ? [
        change.abs === undefined
          ? null
          : `${sign}${formatPrice(Math.abs(change.abs), data.currency, locale)}`,
        change.pct === undefined ? null : `(${sign}${Math.abs(change.pct).toFixed(2)}%)`,
      ].filter((part): part is string => part !== null)
    : [];

  return (
    <CardSurface>
      <View className="flex-row items-baseline gap-2">
        <Text className="text-base font-semibold text-foreground">{data.name}</Text>
        <Text className="text-sm text-muted-foreground">{data.symbol}</Text>
      </View>

      <Text className="mt-1 text-4xl font-medium text-foreground">
        {data.price === undefined
          ? t("market.noPrice")
          : formatPrice(data.price, data.currency, locale)}
      </Text>

      {deltaParts.length > 0 && (
        <View className="mt-1 flex-row flex-wrap items-baseline gap-x-2">
          {/* The sign carries the direction too, so the colour is never the only
              thing saying which way this went. */}
          <Text className="text-base font-medium" style={{ color: semantic }}>
            {deltaParts.join(" ")}
          </Text>
          <Text className="text-sm text-muted-foreground">{t(`market.since.${range}`)}</Text>
        </View>
      )}

      {geometry ? (
        <View className="mt-3">
          <AreaChart geometry={geometry} tint={tint} width={CHART_WIDTH} height={CHART_HEIGHT}>
            {gridValues.map((value) => (
              <Line
                key={value}
                x1={0}
                y1={geometry.yFor(value)}
                x2={PLOT_WIDTH}
                y2={geometry.yFor(value)}
                stroke={colors.border}
                strokeWidth={1}
              />
            ))}
            {gridValues.map((value) => (
              <SvgText
                key={value}
                x={PLOT_WIDTH + 6}
                y={geometry.yFor(value) + 3}
                fill={colors.mutedForeground}
                fontSize={9}
              >
                {formatAxis(value, locale)}
              </SvgText>
            ))}
          </AreaChart>
        </View>
      ) : (
        <Text className="mt-3 text-sm text-muted-foreground">{t("market.noChart")}</Text>
      )}

      {ranges.length > 1 && (
        <View className="mt-3 flex-row gap-0.5 rounded-xl bg-muted p-1">
          {ranges.map((r) => (
            <Pressable
              key={r}
              accessibilityRole="button"
              accessibilityState={{ selected: r === range }}
              accessibilityLabel={t(`market.range.${r}`)}
              className={cn(
                "min-h-[36px] flex-1 items-center justify-center rounded-lg px-1",
                r === range && "bg-card",
              )}
              onPress={() => setRange(r)}
            >
              <Text
                className={cn(
                  "text-xs",
                  r === range ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {t(`market.range.${r}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {stats.length > 0 && (
        <View className="mt-3 flex-row flex-wrap">
          {stats.map((stat) => (
            <View key={stat.key} className="w-1/2 py-1.5 pr-2">
              <Text className="text-xs text-muted-foreground">{t(`market.${stat.key}`)}</Text>
              <Text className="text-sm font-medium text-foreground">{stat.value}</Text>
            </View>
          ))}
        </View>
      )}
    </CardSurface>
  );
}
