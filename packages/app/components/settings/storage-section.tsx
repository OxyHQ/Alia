import { useDocumentPicker } from '@/lib/hooks/use-document-picker';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  useLibraryStore,
  type FileCategory,
  type LibraryFile,
} from '@/lib/stores/library-store';
import type { FileUploadFile } from '@oxy.so/bloom/file-upload';
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

/** The Library API's multer limit (`packages/api/src/routes/library.ts`). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * The Library API takes any type; the dropzone insists on an allow-list, so
 * this is the set people actually upload, grouped as the API categorises them.
 */
const ALLOWED_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'csv', 'xls', 'xlsx', 'ppt', 'pptx', 'json',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg',
  'mp3', 'wav', 'mp4', 'mov', 'zip',
] as const;

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

/** A local URI `addFile` can read: the picker's, or one minted for a dropped DOM `File`. */
function uriFor(file: FileUploadFile): { uri: string; revoke?: () => void } | null {
  if (file.uri) return { uri: file.uri };
  if (Platform.OS === 'web' && typeof Blob !== 'undefined' && file.raw instanceof Blob) {
    const uri = URL.createObjectURL(file.raw);
    return { uri, revoke: () => URL.revokeObjectURL(uri) };
  }
  return null;
}

/** The Library, as Bloom's Storage page: dropzone over the file table. */
export function StorageSection() {
  const { isAuthenticated } = useOxy();
  const files = useLibraryStore((state) => state.files);
  const loading = useLibraryStore((state) => state.loading);
  const loadFiles = useLibraryStore((state) => state.loadFiles);
  const addFile = useLibraryStore((state) => state.addFile);
  const deleteFile = useLibraryStore((state) => state.deleteFile);
  const { pickDocument } = useDocumentPicker();
  const { t, locale } = useTranslation();
  const { colors } = useTheme();

  // The dropzone is fully controlled: `uploading` is the file in flight and
  // `progress` flips to 100 when the API has it, which plays Bloom's success
  // state before `onUploadComplete` clears it.
  const [uploading, setUploading] = useState<FileUploadFile | null>(null);
  const [progress, setProgress] = useState(0);

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

  const handleFileSelected = useCallback(
    async (picked: FileUploadFile) => {
      const source = uriFor(picked);
      if (!source) {
        toast.error(t('library.failedUploadFiles'));
        return;
      }
      setUploading(picked);
      setProgress(0);
      try {
        await addFile({
          name: picked.name,
          uri: source.uri,
          type: picked.mimeType ?? 'application/octet-stream',
          size: picked.size,
        });
        setProgress(100);
        toast.success(t('library.filesUploaded', { count: 1 }));
      } catch {
        setUploading(null);
        toast.error(t('library.failedUploadFiles'));
      } finally {
        source.revoke?.();
      }
    },
    [addFile, t],
  );

  const handlePickFiles = useCallback(async () => {
    const docs = await pickDocument();
    return docs?.map((doc) => ({
      name: doc.name,
      size: doc.size,
      uri: doc.uri,
      mimeType: doc.mimeType,
    }));
  }, [pickDocument]);

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
      upload={{
        file: uploading,
        progress,
        onFileSelected: handleFileSelected,
        onUploadComplete: () => {
          setUploading(null);
          setProgress(0);
        },
        onReject: (message) => toast.error(message),
        // Native has no built-in picker; web keeps the dropzone's own input.
        onPickFiles: Platform.OS === 'web' ? undefined : handlePickFiles,
        allowedExtensions: ALLOWED_EXTENSIONS,
        maxBytes: MAX_UPLOAD_BYTES,
        accessibilityLabel: t('settings.account.storage.uploadLabel'),
        labels: {
          prompt:
            Platform.OS === 'web'
              ? t('settings.account.storage.uploadPrompt')
              : t('settings.account.storage.uploadPromptNative'),
          select:
            Platform.OS === 'web'
              ? t('settings.account.storage.uploadSelect')
              : t('settings.account.storage.uploadSelectNative'),
          uploading: (size) => t('settings.account.storage.uploading', { size }),
          uploaded: t('settings.account.storage.uploaded'),
          unsupported: (extensions) =>
            t('settings.account.storage.unsupported', { extensions }),
          tooLarge: (max) => t('settings.account.storage.tooLarge', { max }),
        },
      }}
    />
  );
}
