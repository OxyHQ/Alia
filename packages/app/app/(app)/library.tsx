import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, ScrollView, Pressable, TextInput, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus, Search } from 'lucide-react-native';
import * as DropdownMenu from '@/components/ui/dropdown-menu';
import { useLibraryStore, FileCategory } from '@/lib/stores/library-store';
import { useImagePicker } from '@/lib/hooks/use-image-picker';
import { useDocumentPicker } from '@/lib/hooks/use-document-picker';
import { FileCard } from '@/components/file-card';
import { cn } from '@/lib/utils';
import { toast } from '@/components/sonner';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Skeleton } from '@/components/ui/skeleton';

export default function LibraryScreen() {
  const files = useLibraryStore((state) => state.files);
  const loading = useLibraryStore((state) => state.loading);
  const loadFiles = useLibraryStore((state) => state.loadFiles);
  const addFile = useLibraryStore((state) => state.addFile);
  const deleteFile = useLibraryStore((state) => state.deleteFile);

  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();
  const { colors } = useColorScheme();
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

  const categories = useMemo(() => [
    { value: null, label: t('common.all') },
    { value: 'documents', label: t('library.documents') },
    { value: 'images', label: t('library.images') },
    { value: 'other', label: t('library.other') },
  ], [t]);

  const filteredFiles = useMemo(() => {
    let filtered = files;

    if (selectedCategory) {
      filtered = filtered.filter(file => file.category === selectedCategory);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(file =>
        file.name.toLowerCase().includes(query) ||
        file.type.toLowerCase().includes(query)
      );
    }

    return filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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

  const handleDeleteFile = useCallback(async (fileId: string) => {
    try {
      await deleteFile(fileId);
      toast.success(t('library.fileDeleted'));
    } catch (error) {
      toast.error(t('library.failedDeleteFile'));
    }
  }, [deleteFile, t]);

  const renderItem = useCallback(({ item: file }: { item: typeof filteredFiles[0] }) => (
    <FileCard
      file={file}
      onDelete={(f) => handleDeleteFile(f._id)}
    />
  ), [handleDeleteFile]);

  const listHeader = useMemo(() => (
    <>
      {/* Header */}
      <View className="px-5 pt-6 pb-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xl font-bold text-foreground">
            {t('library.title')}
          </Text>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button size="icon" className="rounded-full h-8 w-8">
                <Plus size={16} className="text-primary-foreground" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item key="photos" onSelect={handleUploadImage}>
                <DropdownMenu.ItemIcon ios={{ name: "photo" }} />
                <DropdownMenu.ItemTitle>{t('library.addImages')}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="document" onSelect={handleUploadDocument}>
                <DropdownMenu.ItemIcon ios={{ name: "doc" }} />
                <DropdownMenu.ItemTitle>{t('library.uploadFiles')}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </View>
        <Text className="text-[13px] text-muted-foreground mt-0.5">
          {t('library.subtitle')}
        </Text>
      </View>

      {/* Search */}
      <View className="px-5 pt-3 pb-2">
        <View className="flex-row items-center gap-2 bg-muted/70 rounded-lg px-3 py-2">
          <Search size={15} className="text-muted-foreground" />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('library.searchPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            className="flex-1 text-[13px] text-foreground"
          />
        </View>
      </View>

      {/* Category Chips */}
      <View className="py-2">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20 }}
        >
          <View className="flex-row gap-1.5">
            {categories.map((category) => {
              const isActive = selectedCategory === category.value ||
                (!selectedCategory && category.value === null);
              return (
                <Pressable
                  key={category.label}
                  onPress={() => setSelectedCategory(category.value)}
                  className="active:opacity-70"
                >
                  <View className={cn(
                    "px-3 py-1 rounded-full",
                    isActive ? "bg-foreground" : "bg-muted/70"
                  )}>
                    <Text className={cn(
                      "text-xs font-medium",
                      isActive ? "text-background" : "text-muted-foreground"
                    )}>
                      {category.label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* Section Title */}
      <View className="px-5">
        {(searchQuery || selectedCategory) ? (
          <View className="mb-2">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {filteredFiles.length} {filteredFiles.length === 1 ? 'file' : 'files'}
            </Text>
          </View>
        ) : (
          <View className="mb-2">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {t('common.all')}
            </Text>
          </View>
        )}
      </View>

      {/* Skeleton when loading */}
      {loading && files.length === 0 && (
        <View className="px-5 gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <View key={i} className="flex-row items-center gap-3 py-2.5">
              <Skeleton style={{ width: 36, height: 36, borderRadius: 8 }} />
              <View className="flex-1 gap-1.5">
                <Skeleton style={{ width: '60%', height: 12, borderRadius: 6 }} />
                <Skeleton style={{ width: '35%', height: 10, borderRadius: 6 }} />
              </View>
            </View>
          ))}
        </View>
      )}
    </>
  ), [t, searchQuery, selectedCategory, categories, filteredFiles, loading, files, colors, handleUploadImage, handleUploadDocument]);

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <View className="items-center justify-center py-16 px-5">
        <Text className="text-sm font-medium text-foreground">
          {searchQuery ? t('library.noFilesFound') : t('library.noFiles')}
        </Text>
        <Text className="text-xs text-muted-foreground text-center mt-1">
          {searchQuery
            ? t('common.tryDifferentSearch')
            : t('library.uploadToStart')}
        </Text>
      </View>
    );
  }, [loading, t, searchQuery]);

  return (
    <View className="flex-1 bg-background">
      <FlashList
        data={loading && files.length === 0 ? [] : filteredFiles}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}
