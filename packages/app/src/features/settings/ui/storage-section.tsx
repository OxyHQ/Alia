import { useTranslation } from '@/shared/i18n/use-translation';
import {
  useLibraryStore,
  type FileCategory,
  type LibraryFile,
} from '@/features/library/runtime/library-store';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiFileExcel2Line } from '@oxy.so/bloom/icons/RiFileExcel2Line';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import {
  SettingsProfilePage,
  SettingsStoragePage,
  type SettingsFileKind,
  type SettingsMenuAction,
  type SettingsStoredFile,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useMemo } from 'react';
import { View } from 'react-native';


/** Library category -> the storage table's filter key. */
const KIND_FOR_CATEGORY: Record<FileCategory, string> = {
  documents: 'document',
  images: 'image',
  other: 'other',
};

const SPREADSHEET = /\.(csv|xlsx?|numbers)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|avi)$/i;

function toStoredFile(file: LibraryFile, locale: string): SettingsStoredFile {
  return {
    id: file._id,
    name: file.name,
    kind: KIND_FOR_CATEGORY[file.category] ?? 'other',
    uploadedOn: file.createdAt.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    uploadedAt: file.createdAt.getTime(),
    size: file.size,
  };
}


/** The Library, as Bloom's Storage page, read-only: the file table. */
export function StorageSection() {
  const { isAuthenticated } = useOxy();
  const files = useLibraryStore((state) => state.files);
  const loading = useLibraryStore((state) => state.loading);
  const loadFiles = useLibraryStore((state) => state.loadFiles);
  const deleteFile = useLibraryStore((state) => state.deleteFile);
  const { t, locale } = useTranslation();
  const { colors } = useTheme();


  useEffect(() => {
    if (isAuthenticated) void loadFiles();
  }, [isAuthenticated, loadFiles]);

  const storedFiles = useMemo(
    () => files.map((file) => toStoredFile(file, locale)),
    [files, locale],
  );

  const kinds = useMemo<SettingsFileKind[]>(
    () => [
      { value: 'document', label: t('library.documents') },
      { value: 'image', label: t('library.images') },
      { value: 'other', label: t('library.other') },
    ],
    [t],
  );

  const fileActions = useMemo<SettingsMenuAction[]>(
    () => [
      { id: 'open', label: t('settings.account.storage.openFile'), icon: RiExternalLinkLine },
      { id: 'copy-link', label: t('settings.account.storage.copyLink'), icon: RiFileCopyLine },
    ],
    [t],
  );


  const handleDeleteFile = useCallback(
    async (id: string) => {
      try {
        await deleteFile(id);
        toast.success(t('library.fileDeleted'));
      } catch {
        toast.error(t('library.failedDeleteFile'));
      }
    },
    [deleteFile, t],
  );

  const handleFileAction = useCallback(
    async (id: string, action: string) => {
      const file = files.find((f) => f._id === id);
      if (!file?.url) return;
      if (action === 'open') {
        await Linking.openURL(file.url);
      } else if (action === 'copy-link') {
        await Clipboard.setStringAsync(file.url);
        toast.success(t('settings.account.storage.linkCopied'));
      }
    },
    [files, t],
  );

  const renderFileIcon = useCallback(
    ({ name, kind }: Pick<SettingsStoredFile, 'name' | 'kind'>) => {
      const Icon =
        kind === 'image'
          ? RiImageLine
          : SPREADSHEET.test(name)
            ? RiFileExcel2Line
            : VIDEO.test(name)
              ? RiVideoLine
              : RiFileTextLine;
      return <Icon width={24} height={24} fill={colors.textSecondary} />;
    },
    [colors.textSecondary],
  );

  if (!isAuthenticated) {
    return (
      <SettingsProfilePage
        sections={[
          {
            key: 'signed-out',
            rows: [
              {
                key: 'signed-out',
                label: t('settings.account.storage.signedOut'),
                description: t('settings.account.storage.signedOutDescription'),
              },
            ],
          },
        ]}
      />
    );
  }

  if (loading && files.length === 0) {
    // The page's own geometry, shimmering: the dropzone, then the file table.
    return (
      <View className="flex-1 gap-4">
        <Skeleton.Box width="100%" height={164} borderRadius={16} />
        <Skeleton.Box width="100%" height={360} borderRadius={16} />
      </View>
    );
  }

  return (
    <SettingsStoragePage
      files={storedFiles}
      kinds={kinds}
      fileActions={fileActions}
      onFileAction={handleFileAction}
      onDeleteFile={handleDeleteFile}
      renderFileIcon={renderFileIcon}
      // Storage only lists what exists: files attached in chats and files
      // Alia generated. Nothing is uploaded from here.
      upload={false}
    />
  );
}
