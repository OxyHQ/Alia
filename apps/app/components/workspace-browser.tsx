/**
 * WorkspaceBrowser — Tree view of agent workspace files with preview/download.
 *
 * Shows files created by an agent during task execution.
 * Supports expanding directories, previewing text files, and downloading.
 */

import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api/client';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  Download,
  ChevronRight,
  ChevronDown,
  X,
  FolderTree,
} from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';

interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: WorkspaceFile[];
}

interface WorkspaceBrowserProps {
  sessionId: string;
  onClose?: () => void;
}

const FILE_ICON_MAP: Record<string, typeof FileCode> = {
  '.ts': FileCode,
  '.tsx': FileCode,
  '.js': FileCode,
  '.jsx': FileCode,
  '.py': FileCode,
  '.rs': FileCode,
  '.go': FileCode,
  '.java': FileCode,
  '.rb': FileCode,
  '.json': FileCode,
  '.yaml': FileCode,
  '.yml': FileCode,
  '.toml': FileCode,
  '.md': FileText,
  '.txt': FileText,
  '.csv': FileText,
  '.log': FileText,
  '.png': ImageIcon,
  '.jpg': ImageIcon,
  '.jpeg': ImageIcon,
  '.gif': ImageIcon,
  '.svg': ImageIcon,
  '.webp': ImageIcon,
};

function getFileIcon(name: string) {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return FILE_ICON_MAP[ext] || File;
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewable(name: string): boolean {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  const previewable = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.rb',
    '.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.csv', '.log',
    '.html', '.css', '.sh', '.bash', '.zsh', '.sql', '.xml', '.env',
    '.gitignore', '.dockerfile', '.makefile',
  ];
  return previewable.includes(ext) || !name.includes('.');
}

function FileTreeItem({
  file,
  sessionId,
  depth,
  colors,
}: {
  file: WorkspaceFile;
  sessionId: string;
  depth: number;
  colors: any;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [preview, setPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const handlePress = useCallback(async () => {
    if (file.type === 'directory') {
      setExpanded(!expanded);
      return;
    }

    // Toggle preview for text files
    if (isPreviewable(file.name)) {
      if (preview !== null) {
        setPreview(null);
        return;
      }
      setLoadingPreview(true);
      try {
        const res = await apiClient.get(
          `/agents/sessions/${sessionId}/files/${file.path}`,
          { responseType: 'text' },
        );
        setPreview(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
      } catch {
        setPreview('(failed to load file)');
      }
      setLoadingPreview(false);
    }
  }, [file, expanded, preview, sessionId]);

  const handleDownload = useCallback(async () => {
    // On web, trigger download. On native, this would use expo-sharing.
    try {
      const res = await apiClient.get(
        `/agents/sessions/${sessionId}/files/${file.path}`,
        { responseType: 'blob' },
      );
      if (typeof window !== 'undefined' && window.URL) {
        const url = window.URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        window.URL.revokeObjectURL(url);
      }
    } catch {
      // Silently fail — download not available in this env
    }
  }, [file, sessionId]);

  const Icon = file.type === 'directory'
    ? (expanded ? FolderOpen : Folder)
    : getFileIcon(file.name);

  const iconColor = file.type === 'directory' ? '#f59e0b' : colors.mutedForeground;

  return (
    <View>
      <Pressable
        onPress={handlePress}
        className="flex-row items-center py-1.5 active:bg-muted/50"
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        {file.type === 'directory' && (
          expanded
            ? <ChevronDown size={12} color={colors.mutedForeground} style={{ marginRight: 2 }} />
            : <ChevronRight size={12} color={colors.mutedForeground} style={{ marginRight: 2 }} />
        )}
        <Icon size={14} color={iconColor} style={{ marginRight: 6 }} />
        <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
          {file.name}
        </Text>
        {file.size !== undefined && file.type === 'file' && (
          <Text className="text-[10px] text-muted-foreground mr-2">
            {formatFileSize(file.size)}
          </Text>
        )}
        {file.type === 'file' && (
          <Pressable onPress={handleDownload} hitSlop={8} className="p-1">
            <Download size={12} color={colors.mutedForeground} />
          </Pressable>
        )}
        {loadingPreview && (
          <ActivityIndicator size="small" style={{ marginLeft: 4 }} />
        )}
      </Pressable>

      {/* File preview */}
      {preview !== null && (
        <View className="mx-3 mb-2 rounded-lg bg-muted/50 border border-border overflow-hidden">
          <ScrollView
            horizontal={false}
            style={{ maxHeight: 200, padding: 8 }}
          >
            <Text className="text-xs text-foreground font-mono" selectable>
              {preview.length > 5000 ? preview.slice(0, 5000) + '\n\n[truncated]' : preview}
            </Text>
          </ScrollView>
        </View>
      )}

      {/* Children for directories */}
      {expanded && file.children?.map(child => (
        <FileTreeItem
          key={child.path}
          file={child}
          sessionId={sessionId}
          depth={depth + 1}
          colors={colors}
        />
      ))}
    </View>
  );
}

export function WorkspaceBrowser({ sessionId, onClose }: WorkspaceBrowserProps) {
  const { colors } = useColorScheme();

  const { data, isLoading, error } = useQuery<{ files: WorkspaceFile[]; containerId?: string }>({
    queryKey: ['workspace-files', sessionId],
    queryFn: async () => {
      const res = await apiClient.get(`/agents/sessions/${sessionId}/files`);
      return res.data;
    },
    staleTime: 30_000,
  });

  const files = data?.files || [];
  const hasFiles = files.length > 0;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className="rounded-xl border border-border bg-background overflow-hidden"
    >
      {/* Header */}
      <View className="flex-row items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <View className="flex-row items-center gap-2">
          <FolderTree size={14} color={colors.primary} />
          <Text className="text-xs font-semibold text-foreground">Workspace Files</Text>
          {hasFiles && (
            <Text className="text-[10px] text-muted-foreground">
              {countFiles(files)} files
            </Text>
          )}
        </View>
        {onClose && (
          <Pressable onPress={onClose} hitSlop={8} className="p-1">
            <X size={14} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>

      {/* Content */}
      <ScrollView style={{ maxHeight: 320 }}>
        {isLoading && (
          <View className="items-center py-6">
            <ActivityIndicator size="small" />
            <Text className="text-xs text-muted-foreground mt-2">Loading workspace...</Text>
          </View>
        )}

        {!isLoading && error && (
          <View className="items-center py-6 px-4">
            <Text className="text-xs text-muted-foreground text-center">
              Unable to load workspace files. The container may have expired.
            </Text>
          </View>
        )}

        {!isLoading && !error && !hasFiles && (
          <View className="items-center py-6 px-4">
            <Text className="text-xs text-muted-foreground text-center">
              No files in workspace yet.
            </Text>
          </View>
        )}

        {hasFiles && files.map(file => (
          <FileTreeItem
            key={file.path}
            file={file}
            sessionId={sessionId}
            depth={0}
            colors={colors}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}

function countFiles(files: WorkspaceFile[]): number {
  let count = 0;
  for (const f of files) {
    if (f.type === 'file') count++;
    if (f.children) count += countFiles(f.children);
  }
  return count;
}
