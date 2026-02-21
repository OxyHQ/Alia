import React, { useEffect, useState, useMemo } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus, Search } from 'lucide-react-native';
import * as DropdownMenu from '@/components/ui/dropdown-menu';
import { useLibraryStore, FileCategory } from '@/lib/stores/library-store';
import { useImagePicker } from '@/hooks/useImagePicker';
import { useDocumentPicker } from '@/hooks/useDocumentPicker';
import { FileCard } from '@/components/file-card';
import { cn } from '@/lib/utils';
import { toast } from '@/components/sonner';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/hooks/useTranslation';

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
      const uris = await pickImage();
      if (uris && uris.length > 0) {
        for (const uri of uris) {
          const fileName = uri.split('/').pop() || 'image.jpg';
          await addFile({
            name: fileName,
            uri,
            type: 'image/jpeg',
            size: 0,
          });
        }
        toast.success(t('library.imagesUploaded', { count: uris.length }));
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

  const handleDeleteFile = async (fileId: string) => {
    try {
      await deleteFile(fileId);
      toast.success(t('library.fileDeleted'));
    } catch (error) {
      toast.error(t('library.failedDeleteFile'));
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
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

        {/* Files List */}
        <View className="px-5 pb-6">
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

          {loading ? (
            <View className="items-center justify-center py-16">
              <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
            </View>
          ) : filteredFiles.length === 0 ? (
            <View className="items-center justify-center py-16">
              <Text className="text-sm font-medium text-foreground">
                {searchQuery ? t('library.noFilesFound') : t('library.noFiles')}
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1">
                {searchQuery
                  ? t('common.tryDifferentSearch')
                  : t('library.uploadToStart')}
              </Text>
            </View>
          ) : (
            <View>
              {filteredFiles.map((file) => (
                <FileCard
                  key={file._id}
                  file={file}
                  onDelete={(f) => handleDeleteFile(f._id)}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
