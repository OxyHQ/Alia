import React from 'react';
import { View, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import {
  FileText,
  Image as ImageIcon,
  File,
  MoreHorizontal,
} from 'lucide-react-native';
import * as DropdownMenu from '@/components/ui/dropdown-menu';
interface LibraryFile {
  name: string;
  type: string;
  size: number;
  category: string;
  thumbnail?: string;
  createdAt: Date;
}
import { formatFileSize } from '@/lib/utils';

interface FileCardProps {
  file: LibraryFile;
  onPress?: (file: LibraryFile) => void;
  onDelete?: (file: LibraryFile) => void;
}

export function FileCard({ file, onPress, onDelete }: FileCardProps) {
  const getFileIcon = () => {
    if (file.category === 'images') {
      return <ImageIcon size={16} className="text-blue-500" />;
    } else if (file.category === 'documents') {
      return <FileText size={16} className="text-green-500" />;
    } else {
      return <File size={16} className="text-muted-foreground" />;
    }
  };

  const formatDate = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString();
  };

  const subtitle = [
    file.type.split('/').pop()?.toUpperCase(),
    file.size > 0 ? formatFileSize(file.size) : null,
    formatDate(file.createdAt),
  ].filter(Boolean).join(' \u00B7 ');

  return (
    <Pressable
      onPress={() => onPress?.(file)}
      className="active:opacity-70"
    >
      <View className="flex-row items-center py-2.5 gap-3">
        {/* Thumbnail / Icon */}
        <View className="w-9 h-9 rounded-full bg-muted items-center justify-center overflow-hidden">
          {file.category === 'images' && file.thumbnail ? (
            <Image
              source={{ uri: file.thumbnail }}
              className="w-9 h-9"
              contentFit="cover"
              transition={200}
            />
          ) : (
            getFileIcon()
          )}
        </View>

        {/* Content */}
        <View className="flex-1">
          <Text className="text-[14px] font-semibold text-foreground" numberOfLines={1}>
            {file.name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>

        {/* Actions */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Pressable className="h-8 w-8 items-center justify-center rounded-full active:bg-muted/70">
              <MoreHorizontal size={14} className="text-muted-foreground" />
            </Pressable>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item key="delete" destructive onSelect={() => onDelete?.(file)}>
              <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
              <DropdownMenu.ItemTitle>Delete</DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </View>
    </Pressable>
  );
}
