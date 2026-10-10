import { Pressable, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiFolderLine } from '@oxy.so/bloom/icons/RiFolderLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { formatBytes, parentPath, type WorkspaceListing } from '@/features/agents/model/computer';
import { useTranslation } from '@/shared/i18n/use-translation';

/**
 * The agent's `/workspace`, read-only: folders open in place, files show their
 * size. Nothing here writes, deletes or runs anything — the person reads what
 * the agent left (its downloads land in `/workspace/downloads`).
 */
export function WorkspaceFiles({
  running,
  path,
  listing,
  loading,
  starting,
  onOpenDirectory,
  onStart,
}: {
  running: boolean;
  path: string;
  listing: WorkspaceListing | undefined;
  loading: boolean;
  starting: boolean;
  onOpenDirectory: (path: string) => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();

  if (!running) {
    return (
      <View className="gap-2" testID="files-off">
        <Muted>{t('agents.computer.files.off')}</Muted>
        <View className="flex-row">
          <Button tone="neutral" appearance="outline" disabled={starting} onPress={onStart}>
            {t('agents.computer.files.turnOn')}
          </Button>
        </View>
      </View>
    );
  }

  const parent = parentPath(path);
  return (
    <View className="gap-2" testID="files">
      <View className="flex-row items-center justify-between gap-2">
        <Text variant="body-medium" numberOfLines={1}>
          {path}
        </Text>
        {parent ? (
          <Button
            size="sm"
            tone="neutral"
            appearance="plain"
            leadingIcon={RiArrowUpLine}
            onPress={() => onOpenDirectory(parent)}
          >
            {t('agents.computer.files.up')}
          </Button>
        ) : null}
      </View>
      {loading && !listing ? <Loading variant="spinner" /> : null}
      {listing && listing.entries.length === 0 ? (
        <Muted>{t('agents.computer.files.empty')}</Muted>
      ) : null}
      {listing?.entries.map((entry) => {
        const directory = entry.type === 'directory';
        const Icon = directory ? RiFolderLine : RiFileTextLine;
        const row = (
          <View className="flex-row items-center gap-2 py-1.5">
            <Icon size="sm" />
            <Text variant="body-regular" numberOfLines={1} style={{ flex: 1 }}>
              {entry.name}
            </Text>
            {entry.type === 'file' ? <Muted>{formatBytes(entry.size)}</Muted> : null}
          </View>
        );
        return directory ? (
          <Pressable
            key={entry.path}
            accessibilityRole="button"
            onPress={() => onOpenDirectory(entry.path)}
          >
            {row}
          </Pressable>
        ) : (
          <View key={entry.path}>{row}</View>
        );
      })}
      {listing?.truncated ? <Muted>{t('agents.computer.files.truncated')}</Muted> : null}
      <Muted>{t('agents.computer.files.readOnly')}</Muted>
    </View>
  );
}
