import { Button, IconButton } from '@oxy.so/bloom/button';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@oxy.so/bloom/settings-modal';
import { View } from 'react-native';
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
export function MemoryTable({
  heading,
  rows,
  emptyLabel,
  onRowPress,
  onDelete,
}: MemoryTableProps) {
  return (
    <SettingsSection label={heading}>
      <SettingsCard>
        {rows.length ? (
          rows.map((row) => (
            <SettingsRow
              key={row._id}
              label={row.title}
              description={row.summary}
            >
              <View className="flex-row gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => onRowPress(row._id)}
                >
                  Edit
                </Button>
                <IconButton
                  size="sm"
                  tone="danger"
                  icon={RiDeleteBinLine}
                  accessibilityLabel={`Delete ${row.title}`}
                  onPress={() => onDelete(row._id)}
                />
              </View>
            </SettingsRow>
          ))
        ) : (
          <SettingsRow label={emptyLabel} />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
