import { FileCard } from '@/components/file-card';
import { useDocumentPicker } from '@/lib/hooks/use-document-picker';
import { useImagePicker } from '@/lib/hooks/use-image-picker';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useLibraryStore } from '@/lib/stores/library-store';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiFolderLine } from '@oxy.so/bloom/icons/RiFolderLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { FlashList } from '@shopify/flash-list';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';

/**
 * The Library: plain content on the layout's surface.
 *
 * `AiChatContainer` (the app layout) draws the page's background, its corners,
 * the mobile header with the menu button and the "Library" crumb, so this page
 * draws none of them — only its description, its "Add files" action, the search
 * field, the category filter and the files.
 */
export default function LibraryScreen() {
  const files = useLibraryStore((state) => state.files);
  const loading = useLibraryStore((state) => state.loading);
  const loadFiles = useLibraryStore((state) => state.loadFiles);
  const addFile = useLibraryStore((state) => state.addFile);
  const deleteFile = useLibraryStore((state) => state.deleteFile);

  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();
  const { t } = useTranslation();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFiles();
    setRefreshing(false);
  }, [loadFiles]);

  const categories = useMemo(
    () => [
      { value: null, label: t('common.all') },
      { value: 'documents', label: t('library.documents') },
      { value: 'images', label: t('library.images') },
      { value: 'other', label: t('library.other') },
    ],
    [t],
  );

  const filteredFiles = useMemo(() => {
    let filtered = files;

    if (selectedCategory) {
      filtered = filtered.filter((file) => file.category === selectedCategory);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (file) =>
          file.name.toLowerCase().includes(query) ||
          file.type.toLowerCase().includes(query),
      );
    }

    return filtered.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }, [files, searchQuery, selectedCategory]);

  const handleUploadImage = async () => {
    try {
      const assets = await pickImage();
      if (assets && assets.length > 0) {
        for (const asset of assets) {
          await addFile({
            name: asset.name,
            uri: asset.uri,
            type: asset.mimeType,
            size: asset.size,
          });
        }
        toast.success(t('library.imagesUploaded', { count: assets.length }));
      }
    } catch (error) {
      toast.error(t('library.failedUploadImages'));
    }
  };

  const handleUploadDocument = async () => {
    try {
      const docs = await pickDocument();
      if (docs && docs.length > 0) {
        for (const doc of docs) {
          await addFile({
            name: doc.name,
            uri: doc.uri,
            type: doc.mimeType,
            size: doc.size,
          });
        }
        toast.success(t('library.filesUploaded', { count: docs.length }));
      }
    } catch (error) {
      toast.error(t('library.failedUploadFiles'));
    }
  };

  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      try {
        await deleteFile(fileId);
        toast.success(t('library.fileDeleted'));
      } catch (error) {
        toast.error(t('library.failedDeleteFile'));
      }
    },
    [deleteFile, t],
  );

  const renderItem = useCallback(
    ({ item: file }: { item: (typeof filteredFiles)[0] }) => (
      <FileCard file={file} onDelete={(f) => handleDeleteFile(f._id)} />
    ),
    [handleDeleteFile],
  );

  const isFiltered = Boolean(searchQuery || selectedCategory);

  const listHeader = useMemo(
    () => (
      <View style={{ gap: 12, paddingBottom: 8 }}>
        {/* The page's one-line description and its action. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Muted style={{ flex: 1 }}>{t('library.subtitle')}</Muted>
          <DropdownMenu>
            <DropdownMenuTrigger label={t('library.addFiles')} asChild>
              {/* The trigger IS the button, and it is named (#536). */}
              <Button
                tone="action"
                size="sm"
                leadingIcon={RiAddLine}
                accessibilityRole="button"
                accessibilityLabel={t('library.addFiles')}
              >
                {t('library.addFiles')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                key="photos"
                onPress={handleUploadImage}
                leading={<RiImageLine size="sm" />}
              >
                {t('library.addImages')}
              </DropdownMenuItem>
              <DropdownMenuItem
                key="document"
                onPress={handleUploadDocument}
                leading={<RiFileTextLine size="sm" />}
              >
                {t('library.uploadFiles')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        <Search
          label={t('library.searchPlaceholder')}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onClearText={() => setSearchQuery('')}
        />

        <ChipRow role="radiogroup" accessibilityLabel={t('pages.library.categories')}>
          {categories.map((category) => (
            <Chip
              key={category.label}
              size="xl"
              role="radio"
              selected={selectedCategory === category.value}
              onPress={() => setSelectedCategory(category.value)}
            >
              {category.label}
            </Chip>
          ))}
        </ChipRow>

        {isFiltered ? (
          <Muted>
            {t('pages.library.resultCount', { count: filteredFiles.length })}
          </Muted>
        ) : null}

        {loading && files.length === 0 ? (
          <Skeleton.Col style={{ gap: 16, paddingTop: 4 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton.Row key={i} style={{ gap: 12, alignItems: 'center' }}>
                <Skeleton.Circle size={36} />
                <Skeleton.Col style={{ flex: 1, gap: 6 }}>
                  <Skeleton.Text style={{ width: '60%' }} />
                  <Skeleton.Text style={{ width: '35%' }} />
                </Skeleton.Col>
              </Skeleton.Row>
            ))}
          </Skeleton.Col>
        ) : null}
      </View>
    ),
    [
      t,
      searchQuery,
      selectedCategory,
      categories,
      filteredFiles,
      isFiltered,
      loading,
      files,
      handleUploadImage,
      handleUploadDocument,
    ],
  );

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <EmptyState
        icon={RiFolderLine}
        title={searchQuery ? t('library.noFilesFound') : t('library.noFiles')}
        description={
          searchQuery
            ? t('common.tryDifferentSearch')
            : t('library.uploadToStart')
        }
      />
    );
  }, [loading, t, searchQuery]);

  return (
    <FlashList
      data={loading && files.length === 0 ? [] : filteredFiles}
      renderItem={renderItem}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={listEmpty}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 24,
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    />
  );
}
