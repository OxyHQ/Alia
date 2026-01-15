import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Library as LibraryIcon, FileText, Image as ImageIcon, File } from 'lucide-react-native';

export default function LibraryScreen() {
  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="border-b border-border/50 px-6 py-4">
        <View className="flex-row items-center gap-3">
          <LibraryIcon size={24} className="text-foreground" />
          <Text className="text-2xl font-bold text-foreground">Library</Text>
        </View>
        <Text className="text-sm text-muted-foreground mt-1">
          Your files, documents, and resources
        </Text>
      </View>

      {/* Content */}
      <ScrollView className="flex-1 px-6 py-6">
        <View className="items-center justify-center py-20">
          <LibraryIcon size={64} className="text-muted-foreground opacity-50" />
          <Text className="text-lg font-medium text-foreground mt-4">
            Library Coming Soon
          </Text>
          <Text className="text-sm text-muted-foreground text-center mt-2 max-w-md">
            Upload and manage your files, documents, and other resources for use with Alia
          </Text>
        </View>

        {/* Placeholder for future categories */}
        <View className="gap-4 mt-8">
          <View className="border border-border rounded-2xl p-4">
            <View className="flex-row items-center gap-3 mb-2">
              <FileText size={20} className="text-muted-foreground" />
              <Text className="text-base font-medium text-foreground">Documents</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              PDFs, Word docs, and text files
            </Text>
          </View>

          <View className="border border-border rounded-2xl p-4">
            <View className="flex-row items-center gap-3 mb-2">
              <ImageIcon size={20} className="text-muted-foreground" />
              <Text className="text-base font-medium text-foreground">Images</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Photos, screenshots, and diagrams
            </Text>
          </View>

          <View className="border border-border rounded-2xl p-4">
            <View className="flex-row items-center gap-3 mb-2">
              <File size={20} className="text-muted-foreground" />
              <Text className="text-base font-medium text-foreground">Other Files</Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              Code, data, and other file types
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
