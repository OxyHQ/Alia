import React from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import {
  FileText,
  Image as ImageIcon,
  File,
  Trash2,
  Download
} from 'lucide-react-native';
import { LibraryFile } from '@/lib/stores/library-store';
import { cn } from '@/lib/utils';

interface FileCardProps {
  file: LibraryFile;
  onPress?: (file: LibraryFile) => void;
  onDelete?: (file: LibraryFile) => void;
}

export function FileCard({ file, onPress, onDelete }: FileCardProps) {
  const handleDelete = () => {
    Alert.alert(
      'Delete File',
      `Are you sure you want to delete "${file.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => onDelete?.(file)
        },
      ]
    );
  };

  const getFileIcon = () => {
    if (file.category === 'images') {
      return <ImageIcon size={24} className="text-blue-500" />;
    } else if (file.category === 'documents') {
      return <FileText size={24} className="text-green-500" />;
    } else {
      return <File size={24} className="text-gray-500" />;
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
      className="active:opacity-70 w-full"
    >
      <Card className="overflow-hidden">
        <View className="flex-row items-center p-4">
          {/* Thumbnail or Icon */}
          <View className="mr-4">
            {file.category === 'images' && file.thumbnail ? (
              <Image
                source={{ uri: file.thumbnail }}
                className="w-12 h-12 rounded-lg"
                resizeMode="cover"
              />
            ) : (
              <View className="w-12 h-12 rounded-lg bg-muted items-center justify-center">
                {getFileIcon()}
              </View>
            )}
          </View>

          {/* File Info */}
          <View className="flex-1 mr-2">
            <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
              {file.name}
            </Text>
            <View className="flex-row items-center gap-2 mt-1">
              <Text className="text-xs text-muted-foreground">
                {formatFileSize(file.size)}
              </Text>
              <View className="w-1 h-1 rounded-full bg-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {formatDate(file.uploadedAt)}
              </Text>
            </View>
            <View className="px-2 py-0.5 bg-muted rounded-md self-start mt-1">
              <Text className="text-xs text-muted-foreground capitalize">
                {file.category}
              </Text>
            </View>
          </View>

          {/* Actions */}
          <Pressable
            onPress={handleDelete}
            className="p-2 active:opacity-70"
          >
            <Trash2 size={20} className="text-destructive" />
          </Pressable>
        </View>
      </Card>
    </Pressable>
  );
}
