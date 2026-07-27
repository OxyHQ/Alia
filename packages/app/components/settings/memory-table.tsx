import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import { Trash2 } from "lucide-react-native";

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
  if (rows.length === 0) {
    return (
      <SettingsListGroup title={heading}>
        <View className="px-3 py-3">
          <Text className="text-xs text-muted-foreground">{emptyLabel}</Text>
        </View>
      </SettingsListGroup>
    );
  }

  return (
    <SettingsListGroup title={heading}>
      {rows.map((row) => (
        <SettingsListItem
          key={row._id}
          title={row.title}
          description={row.summary}
          value={formatRelativeTime(row.updatedAt)}
          onPress={() => onRowPress(row._id)}
          showChevron={false}
          rightElement={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${row.title}`}
              onPress={(e) => {
                e.stopPropagation();
                onDelete(row._id);
              }}
              className="w-7 h-7 items-center justify-center rounded-md active:bg-destructive/10"
            >
              <Trash2 size={14} className="text-muted-foreground" />
            </Pressable>
          }
        />
      ))}
    </SettingsListGroup>
  );
}
