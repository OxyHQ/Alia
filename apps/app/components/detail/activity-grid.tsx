import React, { useMemo, useState } from "react";
import {
  View,
  Pressable,
  ScrollView,
  useWindowDimensions,
  useColorScheme,
} from "react-native";
import { Text } from "@/components/ui/text";
import { useActivityGrid, type ActivityGridDay } from "@/lib/hooks/use-activity-grid";
import { toast } from "@/components/sonner";

const CELL_SIZE = 11;
const CELL_GAP = 2;
const LABEL_WIDTH = 26;
const MONTH_LABEL_HEIGHT = 16;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface GridCell {
  date: string;
  count: number;
  col: number;
  row: number;
}

interface MonthLabel {
  text: string;
  col: number;
}

function buildGridData(
  apiData: ActivityGridDay[],
  weeks: number
): { cells: GridCell[]; monthLabels: MonthLabel[] } {
  const countMap = new Map(apiData.map((d) => [d.date, d.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const totalDays = weeks * 7;

  // End date is today; start date is totalDays ago, snapped to Monday
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - totalDays + 1);
  const startDay = startDate.getDay();
  const mondayOffset = startDay === 0 ? -6 : 1 - startDay;
  startDate.setDate(startDate.getDate() + mondayOffset);

  const cells: GridCell[] = [];
  const monthLabels: MonthLabel[] = [];
  let lastMonth = -1;

  for (let i = 0; i < totalDays; i++) {
    const cellDate = new Date(startDate);
    cellDate.setDate(startDate.getDate() + i);

    if (cellDate > today) break;

    const dayOfWeek = cellDate.getDay();
    // Mon=0, Tue=1, ..., Sun=6
    const row = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const col = Math.floor(i / 7);

    const dateStr = cellDate.toISOString().slice(0, 10);
    const count = countMap.get(dateStr) || 0;

    cells.push({ date: dateStr, count, col, row });

    const month = cellDate.getMonth();
    if (month !== lastMonth && row === 0) {
      monthLabels.push({ text: MONTH_NAMES[month], col });
      lastMonth = month;
    }
  }

  return { cells, monthLabels };
}

function formatDisplayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getColorForCount(
  count: number,
  maxCount: number,
  isDark: boolean
): string {
  if (count === 0) {
    return isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  }

  const ratio = maxCount > 0 ? count / maxCount : 0;
  if (ratio <= 0.25) return "hsla(288, 77%, 62%, 0.25)";
  if (ratio <= 0.5) return "hsla(288, 77%, 62%, 0.50)";
  if (ratio <= 0.75) return "hsla(288, 77%, 62%, 0.75)";
  return "hsl(288, 77%, 62%)";
}

interface ActivityGridProps {
  agentId: string;
  weeks?: number;
}

export function ActivityGrid({ agentId, weeks: weeksProp }: ActivityGridProps) {
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isLargeScreen = width >= 768;
  const weeks = weeksProp ?? (isLargeScreen ? 52 : 20);

  const { data, isLoading } = useActivityGrid(agentId, weeks);

  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    date: string;
    count: number;
  } | null>(null);

  const { cells, monthLabels } = useMemo(
    () => buildGridData(data?.grid ?? [], weeks),
    [data?.grid, weeks]
  );

  const maxCount = data?.maxCount ?? 0;
  const totalSessions = data?.totalSessions ?? 0;
  const gridWidth = LABEL_WIDTH + weeks * (CELL_SIZE + CELL_GAP);
  const gridHeight = MONTH_LABEL_HEIGHT + 7 * (CELL_SIZE + CELL_GAP);

  if (isLoading) {
    return <View className="h-24 bg-muted/20 rounded-lg" />;
  }

  const handleCellPress = (cell: GridCell) => {
    toast(
      `${cell.count} session${cell.count !== 1 ? "s" : ""} on ${formatDisplayDate(cell.date)}`
    );
  };

  return (
    <View>
      <Text className="text-[11px] text-muted-foreground mb-1.5">
        {totalSessions} session{totalSessions !== 1 ? "s" : ""} in the last{" "}
        {weeks} weeks
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingRight: 8 }}
      >
        <View
          style={{
            width: gridWidth,
            height: gridHeight,
            position: "relative",
          }}
        >
          {/* Month labels */}
          {monthLabels.map((label, i) => (
            <Text
              key={i}
              style={{
                position: "absolute",
                left: LABEL_WIDTH + label.col * (CELL_SIZE + CELL_GAP),
                top: 0,
              }}
              className="text-[9px] text-muted-foreground"
            >
              {label.text}
            </Text>
          ))}

          {/* Day labels (Mon, Wed, Fri) */}
          {[0, 2, 4].map((row) => (
            <Text
              key={row}
              style={{
                position: "absolute",
                left: 0,
                top: MONTH_LABEL_HEIGHT + row * (CELL_SIZE + CELL_GAP) + 1,
              }}
              className="text-[9px] text-muted-foreground"
            >
              {DAY_LABELS[row]}
            </Text>
          ))}

          {/* Grid cells */}
          {cells.map((cell) => (
            <Pressable
              key={cell.date}
              onPress={() => handleCellPress(cell)}
              style={{
                position: "absolute",
                left: LABEL_WIDTH + cell.col * (CELL_SIZE + CELL_GAP),
                top: MONTH_LABEL_HEIGHT + cell.row * (CELL_SIZE + CELL_GAP),
                width: CELL_SIZE,
                height: CELL_SIZE,
                borderRadius: 2,
                backgroundColor: getColorForCount(cell.count, maxCount, isDark),
              }}
            />
          ))}

          {/* Tooltip */}
          {tooltip?.visible && (
            <View
              style={{
                position: "absolute",
                left: tooltip.x,
                top: tooltip.y - 28,
                zIndex: 10,
              }}
              className="bg-popover px-2 py-1 rounded-md border border-border"
            >
              <Text className="text-[10px] text-foreground font-medium">
                {tooltip.count} session{tooltip.count !== 1 ? "s" : ""} on{" "}
                {formatDisplayDate(tooltip.date)}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Color legend */}
      <View className="flex-row items-center justify-end gap-1 mt-1.5">
        <Text className="text-[9px] text-muted-foreground mr-0.5">Less</Text>
        {[0, 0.25, 0.5, 0.75, 1].map((level, i) => (
          <View
            key={i}
            style={{
              width: CELL_SIZE,
              height: CELL_SIZE,
              borderRadius: 2,
              backgroundColor: getColorForCount(
                level === 0 ? 0 : Math.max(1, Math.ceil(level * (maxCount || 1))),
                maxCount || 1,
                isDark
              ),
            }}
          />
        ))}
        <Text className="text-[9px] text-muted-foreground ml-0.5">More</Text>
      </View>
    </View>
  );
}
