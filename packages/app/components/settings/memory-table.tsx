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
  icon: React.ComponentType<{ size?: number; color?: string; className?: string }>;
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

export function MemoryTable({ heading, icon: Icon, rows, emptyLabel, onRowPress, onDelete }: MemoryTableProps) {
  return (
    <View className="gap-xs pt-4">
      <View className="flex-row items-center gap-1.5 px-1">
        <Icon size={13} className="text-muted-foreground" />
        <Text className="text-xs font-semibold text-foreground">{heading}</Text>
      </View>

      {rows.length === 0 ? (
        <View className="px-3 py-3">
          <Text className="text-xs text-muted-foreground">{emptyLabel}</Text>
        </View>
      ) : (
        <View className="border border-border rounded-xl overflow-hidden bg-surface">
          {rows.map((row, index) => (
            <Pressable
              key={row._id}
              onPress={() => onRowPress(row._id)}
              className={cn(
                "flex-row items-center px-3 py-2.5 gap-2 group active:bg-accent/50",
                index !== rows.length - 1 && "border-b border-border"
              )}
            >
              <View className="flex-1 min-w-0">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {row.title}
                </Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {row.summary}
                </Text>
              </View>

              <Text className="text-[10px] text-muted-foreground/60 shrink-0 md:block hidden">
                {formatRelativeTime(row.updatedAt)}
              </Text>

              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  onDelete(row._id);
                }}
                className="w-7 h-7 items-center justify-center rounded-md shrink-0 active:bg-destructive/10 web:opacity-0 web:group-hover:opacity-100"
              >
                <Trash2 size={14} className="text-muted-foreground" />
              </Pressable>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
