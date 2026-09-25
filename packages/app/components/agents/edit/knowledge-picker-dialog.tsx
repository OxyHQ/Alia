import type { LinkedFile } from '@/lib/hooks/agents/use-agent-autosave';
import {
  linkedFileFrom,
  unlinkedFiles,
} from '@/lib/hooks/agents/use-agent-editor-options';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { LibraryFile } from '@/lib/stores/library-store';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiFileTextLine } from '@oxy.so/bloom/icons';
import { Item } from '@oxy.so/bloom/item';
import { Search } from '@oxy.so/bloom/search';
import { Muted } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

/** Pick one more library file for the agent to know. */
export function KnowledgePickerDialog({
  open,
  onClose,
  files,
  linked,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** The person's library. */
  files: readonly LibraryFile[];
  /** The files the agent already knows, which the list leaves out. */
  linked: readonly LinkedFile[];
  onPick: (file: LinkedFile) => void;
}) {
  const { t } = useTranslation();
  const isLargeScreen = useIsLargeScreen();
  const [search, setSearch] = useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('agents.knowledge')}
      // The picker owns its own ScrollView and its own padding.
      scrollable={false}
      contentPadding={0}
    >
      <View className="px-4 pb-2">
        <Search
          label={t('agents.searchLibrary')}
          value={search}
          onChangeText={setSearch}
          onClearText={() => setSearch('')}
          autoFocus
        />
      </View>
      <ScrollView className={isLargeScreen ? 'max-h-[300px]' : 'flex-1'}>
        {unlinkedFiles(files, linked, search).map((file) => (
          <Item
            key={file._id}
            role="option"
            onPress={() => {
              onPick(linkedFileFrom(file));
              onClose();
              setSearch('');
            }}
            leading={<RiFileTextLine size="sm" />}
            title={file.name}
          />
        ))}
        {files.length === 0 && (
          <Muted className="p-4 text-center text-sm text-muted-foreground">
            {t('agents.libraryEmpty')}
          </Muted>
        )}
      </ScrollView>
    </Dialog>
  );
}
