import React from 'react';
import { View, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import {
  FileText,
  Image as ImageIcon,
  File,
  Trash2
} from 'lucide-react-native';
import { LibraryFile } from '@/lib/stores/library-store';

interface FileCardProps {
  file: LibraryFile;
  onPress?: (file: LibraryFile) => void;
  onDelete?: (file: LibraryFile) => void;
}

export function FileCard({ file, onPress, onDelete }: FileCardProps) {
  const handleDelete = (e: any) => {
    // Prevent event bubbling to parent Pressable
    e?.stopPropagation?.();
    onDelete?.(file);
  };

  const getFileIcon = () => {
    if (file.category === 'images') {
      return <ImageIcon size={16} className="text-blue-500" />;
    } else if (file.category === 'documents') {
      return <FileText size={16} className="text-green-500" />;
    } else {
      return <File size={16} className="text-muted-foreground" />;
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;

    return date.toLocaleDateString();
  };

  return (
    <Pressable
      onPress={() => onPress?.(file)}
      className="active:bg-muted/50 w-full"
    >
      <View className="flex-row items-center border-b border-border px-3 py-2 hover:bg-muted/50 transition-colors">
        {/* Thumbnail or Icon */}
        <View className="w-8 mr-2">
          {file.category === 'images' && file.thumbnail ? (
            <Image
              source={{ uri: file.thumbnail }}
              className="w-8 h-8 rounded"
              contentFit="cover"
              placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
              transition={200}
            />
          ) : (
            <View className="w-8 h-8 rounded bg-muted items-center justify-center">
              {getFileIcon()}
            </View>
          )}
        </View>

        {/* Name - takes most space */}
        <View className="flex-1 mr-3">
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {file.name}
          </Text>
        </View>

        {/* Category */}
        <View className="w-20 mr-3 hidden md:flex">
          <Text className="text-xs text-muted-foreground capitalize">
            {file.category}
          </Text>
        </View>

        {/* Size */}
        <View className="w-16 mr-3 hidden md:flex">
          <Text className="text-xs text-muted-foreground">
            {formatFileSize(file.size)}
          </Text>
        </View>

        {/* Date */}
        <View className="w-20 mr-3 hidden md:flex">
          <Text className="text-xs text-muted-foreground">
            {formatDate(file.uploadedAt)}
          </Text>
        </View>

        {/* Actions */}
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            handleDelete(e);
          }}
          className="p-1.5 rounded hover:bg-muted active:opacity-70"
        >
          <Trash2 size={16} className="text-muted-foreground hover:text-destructive" />
        </Pressable>
      </View>
    </Pressable>
  );
}
