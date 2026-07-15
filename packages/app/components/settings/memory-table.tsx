import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Trash2 } from "lucide-react-native";
import { cn } from "@/lib/utils";

interface MemoryRow {
  _id: string;
  title: string;
  summary: string;
  updatedAt: string;
}

interface MemoryTableProps {
  heading: string;
  rows: MemoryRow[];
  emptyLabel: string;
  onRowPress: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function MemoryTable({ heading, rows, emptyLabel, onRowPress, onDelete }: MemoryTableProps) {
  return (
    <View className="gap-1 pt-4">
      <Text className="pl-1 text-sm font-semibold text-foreground">{heading}</Text>

      {rows.length === 0 ? (
        <View className="px-1 py-3">
          <Text className="text-xs text-muted-foreground">{emptyLabel}</Text>
        </View>
      ) : (
        <View>
          {rows.map((row, index) => (
            <Pressable
              key={row._id}
              onPress={() => onRowPress(row._id)}
              className={cn(
                "flex-row items-center h-9 gap-4 px-3 group active:bg-accent/50 active:rounded-md web:hover:bg-accent/40 web:hover:rounded-md",
                "border-b border-border",
                index === 0 && "border-t border-border"
              )}
            >
              <Text className="w-40 shrink-0 text-sm text-foreground" numberOfLines={1}>
                {row.title}
              </Text>
              <Text className="flex-1 min-w-0 text-sm text-muted-foreground" numberOfLines={1}>
                {row.summary}
              </Text>
              <Text className="w-36 shrink-0 text-xs text-muted-foreground md:block hidden" numberOfLines={1}>
                Updated {formatRelativeTime(row.updatedAt)}
              </Text>
              <View className="w-10 shrink-0 items-end">
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    onDelete(row._id);
                  }}
                  className="w-7 h-7 items-center justify-center rounded-md active:bg-destructive/10 web:opacity-0 web:group-hover:opacity-100"
                >
                  <Trash2 size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
