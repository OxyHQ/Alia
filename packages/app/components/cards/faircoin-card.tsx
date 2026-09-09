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
 * FairCoin's price, drawn from the snapshot stored with the message.
 *
 * FairCoin has no exchange listing, so this number did not come off a ticker.
 * `packages/api/src/lib/tools/faircoin.ts` reads the explorer, which publishes
 * GeckoTerminal's INDEXED price for the WFAIR/USDC pool on Base rather than the
 * pool's on-chain spot, because an instantaneous tick on a low-liquidity pool
 * can be moved inside a single block. That is the reason the tool carries
 * `source` and `updatedAt`, and the reason this card prints them in the reading
 * order instead of behind a tap: a price sourced this thinly must not present
 * itself with the confidence of an exchange quote.
 *
 * The five ranges are the ones the explorer retains. The crypto card's eight
 * would be offering history that was never sampled.
 */

/** `[msSinceEpoch, priceUsd]`, exactly as the tool stored it. */
export type FairCoinPoint = [number, number];

export interface FairCoinCardData {
  /**
   * `null` is a real answer, not a failure: the pool had no indexed price at
   * the moment the question was asked.
   */
  price: number | null;
  changePct: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  /** Where the number came from, which is the one thing this card cannot drop. */
  source: string;
  updatedAt: string;
  /**
   * Absent key and empty array mean different things and are kept apart all the
   * way to the screen: the tool omits a period whose fetch failed, and stores
   * `[]` for one the explorer has no samples for yet.
   */
  series: Record<string, FairCoinPoint[] | undefined>;
}

/** Exactly what the explorer retains, in the order the control offers them. */
const RANGES = ["24h", "7d", "30d", "1y", "all"] as const;
type Range = (typeof RANGES)[number];

const CHART_HEIGHT = 140;
const CHART_WIDTH = 320;
/** Room on the right for the axis labels, which sit beside the plot, not on it. */
const AXIS_GUTTER = 46;
const PLOT_WIDTH = CHART_WIDTH - AXIS_GUTTER;
const CHART_PADDING = 8;
const GRID_LINES = 4;

/**
 * A field the row did not carry reads the same as one the pool could not price,
 * and neither is a number to format. `Number.isFinite` covers the `null` the
 * tool sends, the `undefined` an older stored row may have, and a `NaN` that
 * survived a parse — printing any of those three is the failure this guards.
 */
const quoted = (value: number | null): value is number => Number.isFinite(value);

/** FAIR trades at four hundredths of a dollar; two decimals is "$0.04" for everything. */
const priceDigits = (value: number) => (Math.abs(value) < 1 ? 6 : 2);

/** The explorer prices FAIR in USD and in nothing else, so there is no currency to carry. */
const formatPrice = (value: number, locale: string) =>
  value.toLocaleString(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: priceDigits(value),
  });

/**
 * The scale names are not a suffix that can be appended in one language and
 * reused in the next — Spanish "billón" is 10¹², not 10⁹ — so the whole
 * shortened number, currency included, goes through a translation.
 */
const SCALES = [
  { at: 1e12, key: "trillion" },
  { at: 1e9, key: "billion" },
  { at: 1e6, key: "million" },
  { at: 1e3, key: "thousand" },
] as const;

function formatCompact(
  value: number,
  locale: string,
  t: (key: string, params?: Record<string, string>) => string,
) {
  const scale = SCALES.find((s) => Math.abs(value) >= s.at);
  if (!scale) return formatPrice(value, locale);
  return t(`faircoin.scale.${scale.key}`, {
    value: (value / scale.at).toLocaleString(locale, { maximumFractionDigits: 2 }),
  });
}

/** The axis labels a price scale, not a currency: no symbol, and no decimals it does not need. */
const formatAxis = (value: number, locale: string) =>
  value.toLocaleString(locale, {
    maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 6,
  });

export function FairCoinCard({ data }: { data: FairCoinCardData }) {
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();

  // Offered is "the explorer answered for this period", which is not the same
  // as "there is a line to draw": an empty range still gets a button, so that
  // "no samples yet" can be said out loud rather than looking like a period
  // nobody asked about.
  const offered = useMemo(() => RANGES.filter((r) => data.series[r] !== undefined), [data.series]);
  const missing = useMemo(() => RANGES.filter((r) => data.series[r] === undefined), [data.series]);

  const [range, setRange] = useState<Range>(() => {
    const drawable = offered.find((r) => (data.series[r]?.length ?? 0) >= 2);
    return offered.includes("24h") && (data.series["24h"]?.length ?? 0) >= 2
      ? "24h"
      : (drawable ?? offered[0] ?? "24h");
  });

  const points = data.series[range];

  const geometry = useMemo(
    () =>
      areaGeometry((points ?? []).map(([, price]) => price), {
        width: PLOT_WIDTH,
        height: CHART_HEIGHT,
        padding: CHART_PADDING,
      }),
    [points],
  );

  const change = useMemo(() => {
    // 24h reports the explorer's own figure rather than the ends of the series:
    // that series starts at whatever moment the window opened, which is not
    // exactly a day ago.
    if (range === "24h" && quoted(data.changePct)) return { pct: data.changePct, abs: null };
    const run = data.series[range];
    if (!run || run.length < 2) return null;
    const first = run[0][1];
    const last = run[run.length - 1][1];
    // Something that was worth nothing has no percentage change from nothing.
    return { pct: first === 0 ? null : ((last - first) / first) * 100, abs: last - first };
  }, [data.changePct, data.series, range]);

  const direction = change === null ? null : (change.pct ?? change.abs ?? 0) >= 0 ? "up" : "down";
  // Bloom resolves these per colour scheme, so the pair reads in light and in
  // dark without a second set of values.
  const semantic = direction === "down" ? colors.error : colors.success;
  const tint = direction === null ? colors.primary : semantic;

  const gridValues = useMemo(() => {
    if (!geometry) return [];
    // A flat range has one price, and four labels all reading it, stacked on one
    // line, is worse than saying it once.
    if (geometry.max === geometry.min) return [geometry.min];
    return Array.from(
      { length: GRID_LINES },
      (_, i) => geometry.min + ((geometry.max - geometry.min) * i) / (GRID_LINES - 1),
    );
  }, [geometry]);

  // An unparseable stamp is left out rather than printed raw: "Updated
  // Invalid Date" reads as a broken card, and the source alone is still true.
  const updated = useMemo(() => {
    const at = Date.parse(data.updatedAt);
    return Number.isNaN(at)
      ? null
      : new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  }, [data.updatedAt, locale]);

  const stats = useMemo(() => {
    const entries: { key: string; value: string }[] = [];
    if (quoted(data.volume24h)) {
      entries.push({ key: "volume", value: formatCompact(data.volume24h, locale, t) });
    }
    if (quoted(data.liquidityUsd)) {
      entries.push({ key: "liquidity", value: formatCompact(data.liquidityUsd, locale, t) });
    }
    if (quoted(data.marketCapUsd)) {
      entries.push({ key: "marketCap", value: formatCompact(data.marketCapUsd, locale, t) });
    }
    return entries;
  }, [data.liquidityUsd, data.marketCapUsd, data.volume24h, locale, t]);

  const sign = direction === "up" ? "+" : "-";
  const deltaParts = change
    ? [
        change.abs === null ? null : `${sign}${formatPrice(Math.abs(change.abs), locale)}`,
        change.pct === null ? null : `(${sign}${Math.abs(change.pct).toFixed(2)}%)`,
      ].filter((part): part is string => part !== null)
    : [];

  // Three ways to have no line, and a reader has to be able to tell them apart:
  // the explorer holds no samples for this period yet, it holds a single one
  // that is a dot rather than a line, or it never answered at all.
  const emptyKey =
    points === undefined ? "noHistory" : points.length === 0 ? "noSamples" : "noChart";

  return (
    <CardSurface>
      <View className="flex-row items-baseline gap-2">
        <Text className="text-base font-semibold text-foreground">{t("faircoin.name")}</Text>
        <Text className="text-sm text-muted-foreground">{t("faircoin.symbol")}</Text>
      </View>

      <Text className="mt-1 text-4xl font-medium text-foreground">
        {quoted(data.price) ? formatPrice(data.price, locale) : t("faircoin.noPrice")}
      </Text>

      {!quoted(data.price) && (
        <Text className="mt-1 text-sm text-muted-foreground">{t("faircoin.noPriceHint")}</Text>
      )}

      {deltaParts.length > 0 && (
        <View className="mt-1 flex-row flex-wrap items-baseline gap-x-2">
          {/* The sign carries the direction too, so the colour is never the only
              thing saying which way this went. */}
          <Text className="text-base font-medium" style={{ color: semantic }}>
            {deltaParts.join(" ")}
          </Text>
          <Text className="text-sm text-muted-foreground">{t(`faircoin.since.${range}`)}</Text>
        </View>
      )}

      {/* Where the price came from, in the reading order and in full words. A
          number off a thin pool that looks exactly like a Bitcoin quote is the
          one thing this card is not allowed to ship. */}
      <View className="mt-3 rounded-xl bg-muted px-3 py-2">
        <Text className="text-xs font-medium text-foreground">{t("faircoin.indexed")}</Text>
        <View className="mt-0.5 flex-row flex-wrap gap-x-3">
          <Text className="text-xs text-muted-foreground">
            {t("faircoin.source", { source: data.source })}
          </Text>
          {updated !== null && (
            <Text className="text-xs text-muted-foreground">
              {t("faircoin.updated", { time: updated })}
            </Text>
          )}
        </View>
      </View>

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
        <Text className="mt-3 text-sm text-muted-foreground">{t(`faircoin.${emptyKey}`)}</Text>
      )}

      {offered.length > 1 && (
        <View className="mt-3 flex-row gap-0.5 rounded-xl bg-muted p-1">
          {offered.map((r) => (
            <Pressable
              key={r}
              accessibilityRole="button"
              accessibilityState={{ selected: r === range }}
              accessibilityLabel={t(`faircoin.range.${r}`)}
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
                {t(`faircoin.range.${r}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* A period the explorer never answered for is named, because a range that
          simply is not there reads as one that does not exist. */}
      {missing.length > 0 && (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t("faircoin.unavailable", {
            ranges: missing.map((r) => t(`faircoin.range.${r}`)).join(", "),
          })}
        </Text>
      )}

      {stats.length > 0 && (
        <View className="mt-3 flex-row flex-wrap">
          {stats.map((stat) => (
            <View key={stat.key} className="w-1/2 py-1.5 pr-2">
              <Text className="text-xs text-muted-foreground">{t(`faircoin.${stat.key}`)}</Text>
              <Text className="text-sm font-medium text-foreground">{stat.value}</Text>
            </View>
          ))}
        </View>
      )}
    </CardSurface>
  );
}
