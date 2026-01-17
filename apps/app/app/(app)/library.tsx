import React, { useEffect, useState, useMemo } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  Library as LibraryIcon,
  FileText,
  Image as ImageIcon,
  File,
  Plus,
  Search,
  Upload
} from 'lucide-react-native';
import { useLibraryStore, FileCategory } from '@/lib/stores/library-store';
import { useImagePicker } from '@/hooks/useImagePicker';
import { useDocumentPicker } from '@/hooks/useDocumentPicker';
import { FileCard } from '@/components/file-card';
import { cn } from '@/lib/utils';
import { toast } from '@/components/sonner';

export default function LibraryScreen() {
  const files = useLibraryStore((state) => state.files);
  const loading = useLibraryStore((state) => state.loading);
  const loadFiles = useLibraryStore((state) => state.loadFiles);
  const addFile = useLibraryStore((state) => state.addFile);
  const deleteFile = useLibraryStore((state) => state.deleteFile);

  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const categories = [
    { value: null, label: 'All', icon: LibraryIcon },
    { value: 'documents', label: 'Documents', icon: FileText },
    { value: 'images', label: 'Images', icon: ImageIcon },
    { value: 'other', label: 'Other', icon: File },
  ];

  // Filter files based on search and category
  const filteredFiles = useMemo(() => {
    let filtered = files;

    // Filter by category
    if (selectedCategory) {
      filtered = filtered.filter(file => file.category === selectedCategory);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(file =>
        file.name.toLowerCase().includes(query) ||
        file.type.toLowerCase().includes(query)
      );
    }

    // Sort by upload date (newest first)
    return filtered.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
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
            size: 0, // Would need to fetch actual size
            category: 'images',
            thumbnail: uri,
          });
        }
        toast.success(`${uris.length} image(s) uploaded successfully`);
      }
    } catch (error) {
      toast.error('Failed to upload images');
    }
  };

  const handleUploadDocument = async () => {
    try {
      const docs = await pickDocument();
      if (docs && docs.length > 0) {
        for (const doc of docs) {
          const category: FileCategory = doc.mimeType.startsWith('image/')
            ? 'images'
            : doc.mimeType.includes('pdf') || doc.mimeType.includes('document')
            ? 'documents'
            : 'other';

          await addFile({
            name: doc.name,
            uri: doc.uri,
            type: doc.mimeType,
            size: doc.size,
            category,
            thumbnail: doc.mimeType.startsWith('image/') ? doc.uri : undefined,
          });
        }
        toast.success(`${docs.length} file(s) uploaded successfully`);
      }
    } catch (error) {
      toast.error('Failed to upload files');
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    try {
      await deleteFile(fileId);
      toast.success('File deleted successfully');
    } catch (error) {
      toast.error('Failed to delete file');
    }
  };

  const getCategoryStats = (category: FileCategory) => {
    return files.filter(f => f.category === category).length;
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1">
        {/* Hero Section */}
        <View className="items-center px-6 py-12">
          <LibraryIcon size={48} className="text-primary mb-4" />
          <Text className="text-4xl font-bold text-foreground mb-3 text-center">
            Library
          </Text>
          <Text className="text-base text-muted-foreground mb-6 text-center max-w-md">
            Upload and manage your files, documents, and resources for use with Alia
          </Text>

          {/* Search Bar */}
          <View className="w-full max-w-md flex-row items-center gap-2 bg-muted rounded-full px-4 py-3 mb-4">
            <Search size={18} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search files..."
              placeholderTextColor="#6b7280"
              className="flex-1 text-sm text-foreground"
            />
          </View>

          {/* Upload Buttons */}
          <View className="flex-row gap-2 w-full max-w-md">
            <Button
              onPress={handleUploadImage}
              variant="outline"
              className="flex-1 h-11 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <ImageIcon size={18} className="text-foreground" />
                <Text className="text-sm font-semibold text-foreground">
                  Add Images
                </Text>
              </View>
            </Button>
            <Button
              onPress={handleUploadDocument}
              className="flex-1 h-11 rounded-full"
            >
              <View className="flex-row items-center gap-2">
                <Upload size={18} className="text-primary-foreground" />
                <Text className="text-sm font-semibold text-primary-foreground">
                  Upload Files
                </Text>
              </View>
            </Button>
          </View>
        </View>

        {/* Category Chips */}
        <View className="px-6 pb-4">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {categories.map((category) => {
                const Icon = category.icon;
                const isSelected = selectedCategory === category.value || (!selectedCategory && category.value === null);
                const count = category.value ? getCategoryStats(category.value as FileCategory) : files.length;

                return (
                  <Pressable
                    key={category.label}
                    onPress={() => setSelectedCategory(category.value)}
                    className="active:opacity-70"
                  >
                    <View className={cn(
                      "px-4 py-2 rounded-full border flex-row items-center gap-2",
                      isSelected
                        ? "bg-primary border-primary"
                        : "bg-background border-border"
                    )}>
                      <Icon
                        size={16}
                        className={cn(
                          isSelected ? "text-primary-foreground" : "text-foreground"
                        )}
                      />
                      <Text className={cn(
                        "text-sm font-medium",
                        isSelected ? "text-primary-foreground" : "text-foreground"
                      )}>
                        {category.label}
                      </Text>
                      <View className={cn(
                        "px-1.5 py-0.5 rounded-full min-w-[20px] items-center justify-center",
                        isSelected ? "bg-primary-foreground/20" : "bg-muted"
                      )}>
                        <Text className={cn(
                          "text-xs font-semibold",
                          isSelected ? "text-primary-foreground" : "text-muted-foreground"
                        )}>
                          {count}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>

        {/* Files List */}
        <View className="px-6 pb-6">
          {loading ? (
            <View className="items-center justify-center py-20">
              <Text className="text-muted-foreground">Loading...</Text>
            </View>
          ) : filteredFiles.length === 0 ? (
            <View className="items-center justify-center py-20">
              <LibraryIcon size={64} className="text-muted-foreground opacity-50" />
              <Text className="text-lg font-medium text-foreground mt-4">
                {searchQuery ? 'No files found' : 'No files yet'}
              </Text>
              <Text className="text-sm text-muted-foreground text-center mt-2 max-w-md">
                {searchQuery
                  ? 'Try a different search term'
                  : 'Upload images or documents to get started'}
              </Text>
            </View>
          ) : (
            <View className="border border-border rounded-lg overflow-hidden bg-surface">
              {/* Table Header */}
              <View className="flex-row items-center border-b border-border px-3 py-2 bg-muted/30">
                <View className="w-8 mr-2" />
                <View className="flex-1 mr-3">
                  <Text className="text-xs font-medium text-muted-foreground">Name</Text>
                </View>
                <View className="w-20 mr-3 hidden md:flex">
                  <Text className="text-xs font-medium text-muted-foreground">Category</Text>
                </View>
                <View className="w-16 mr-3 hidden md:flex">
                  <Text className="text-xs font-medium text-muted-foreground">Size</Text>
                </View>
                <View className="w-20 mr-3 hidden md:flex">
                  <Text className="text-xs font-medium text-muted-foreground">Date</Text>
                </View>
                <View className="w-8" />
              </View>

              {/* Table Body */}
              {filteredFiles.map((file) => (
                <FileCard
                  key={file.id}
                  file={file}
                  onDelete={(f) => handleDeleteFile(f.id)}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
