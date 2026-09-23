import apiClient from '@/lib/api/client';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { CodeBlock } from '@oxy.so/bloom/code';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { RiFileCodeLine } from '@oxy.so/bloom/icons/RiFileCodeLine';
import { RiFileImageLine } from '@oxy.so/bloom/icons/RiFileImageLine';
import { RiFilePaper2Line } from '@oxy.so/bloom/icons/RiFilePaper2Line';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiFolder3Line } from '@oxy.so/bloom/icons/RiFolder3Line';
import { RiFolderLine } from '@oxy.so/bloom/icons/RiFolderLine';
import { RiFolderOpenLine } from '@oxy.so/bloom/icons/RiFolderOpenLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * WorkspaceBrowser — the files an agent wrote during a task, as a tree of
 * Bloom `Item` rows: directories expand in place (each level indented by
 * nesting), text files open a `CodeBlock` preview, and every file downloads.
 */

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

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.json', '.yaml', '.yml', '.toml'];
const TEXT_EXTENSIONS = ['.md', '.txt', '.csv', '.log'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
const PREVIEWABLE = [
  ...CODE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  '.html', '.css', '.sh', '.bash', '.zsh', '.sql', '.xml', '.env',
  '.gitignore', '.dockerfile', '.makefile',
];
/** How much of a file the preview shows. */
const PREVIEW_LIMIT = 5000;

function extension(name: string): string {
  return name.substring(name.lastIndexOf('.')).toLowerCase();
}

function fileIcon(name: string): BloomIconComponent {
  const ext = extension(name);
  if (CODE_EXTENSIONS.includes(ext)) return RiFileCodeLine;
  if (TEXT_EXTENSIONS.includes(ext)) return RiFileTextLine;
  if (IMAGE_EXTENSIONS.includes(ext)) return RiFileImageLine;
  return RiFilePaper2Line;
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewable(name: string): boolean {
  return PREVIEWABLE.includes(extension(name)) || !name.includes('.');
}

function countFiles(files: WorkspaceFile[]): number {
  let count = 0;
  for (const f of files) {
    if (f.type === 'file') count++;
    if (f.children) count += countFiles(f.children);
  }
  return count;
}

function FileTreeItem({ file, sessionId, depth }: { file: WorkspaceFile; sessionId: string; depth: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(depth === 0);
  const [preview, setPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const isDirectory = file.type === 'directory';

  const handlePress = useCallback(async () => {
    if (isDirectory) {
      setExpanded(!expanded);
      return;
    }
    if (!isPreviewable(file.name)) return;
    if (preview !== null) {
      setPreview(null);
      return;
    }
    setLoadingPreview(true);
    try {
      const res = await apiClient.get(`/agents/sessions/${sessionId}/files/${file.path}`, { responseType: 'text' });
      setPreview(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
    } catch {
      setPreview(t('panels.workspace.previewFailed'));
    }
    setLoadingPreview(false);
  }, [file, isDirectory, expanded, preview, sessionId, t]);

  const handleDownload = useCallback(async () => {
    // On web, trigger download. On native, this would use expo-sharing.
    try {
      const res = await apiClient.get(`/agents/sessions/${sessionId}/files/${file.path}`, { responseType: 'blob' });
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

  const Icon = isDirectory ? (expanded ? RiFolderOpenLine : RiFolderLine) : fileIcon(file.name);
  const Chevron = expanded ? RiArrowDownSLine : RiArrowRightSLine;

  return (
    <View>
      <Item
        density="compact"
        leading={
          <View className="flex-row items-center gap-0.5">
            {isDirectory ? <Chevron size="xs" fill={colors.textSecondary} /> : null}
            <Icon size="sm" fill={isDirectory ? colors.warning : colors.textSecondary} />
          </View>
        }
        title={file.name}
        expanded={isDirectory ? expanded : undefined}
        onPress={handlePress}
        trailing={
          isDirectory ? null : (
            <View className="flex-row items-center gap-1">
              {file.size !== undefined ? <Muted>{formatFileSize(file.size)}</Muted> : null}
              {loadingPreview ? <Loading size="sm" iconSize={12} /> : null}
              <Button
                appearance="plain"
                tone="neutral"
                size="xs"
                accessibilityLabel={t('panels.workspace.download', { name: file.name })}
                onPress={handleDownload}
                icon={<RiDownloadLine size="xs" fill={colors.textSecondary} />}
              />
            </View>
          )
        }
      />

      {preview !== null ? (
        <View className="px-3 pb-2">
          <ScrollView className="max-h-[200px]" nestedScrollEnabled>
            <CodeBlock
              code={preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}\n\n${t('panels.workspace.truncated')}` : preview}
              filename={file.name}
              lineNumbers={false}
              wrap
              onCopy={async (code) => {
                await Clipboard.setStringAsync(code);
              }}
              labels={{ copy: t('panels.code.copy'), copied: t('panels.code.copied') }}
            />
          </ScrollView>
        </View>
      ) : null}

      {expanded && file.children && file.children.length > 0 ? (
        <View className="pl-4">
          {file.children.map((child) => (
            <FileTreeItem key={child.path} file={child} sessionId={sessionId} depth={depth + 1} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function WorkspaceBrowser({ sessionId, onClose }: WorkspaceBrowserProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

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
    <Card appearance="outline" radius="radius-12">
      <View className="flex-row items-center justify-between gap-2 px-3 py-2">
        <View className="min-w-0 shrink flex-row items-center gap-2">
          <RiFolder3Line size="sm" fill={colors.textSecondary} />
          <Text variant="body-semibold">{t('panels.workspace.title')}</Text>
          {hasFiles ? <Muted>{t('panels.workspace.fileCount', { count: countFiles(files) })}</Muted> : null}
        </View>
        {onClose ? (
          <Button
            appearance="plain"
            tone="neutral"
            size="xs"
            accessibilityLabel={t('common.close')}
            onPress={onClose}
            icon={<RiCloseLine size="sm" fill={colors.textSecondary} />}
          />
        ) : null}
      </View>

      <ScrollView className="max-h-80">
        {isLoading ? (
          <EmptyState
            variant="compact"
            illustration={<Loading size="sm" iconSize={20} />}
            description={t('panels.workspace.loading')}
          />
        ) : error ? (
          <EmptyState variant="compact" description={t('panels.workspace.loadFailed')} />
        ) : !hasFiles ? (
          <EmptyState variant="compact" description={t('panels.workspace.empty')} />
        ) : (
          files.map((file) => <FileTreeItem key={file.path} file={file} sessionId={sessionId} depth={0} />)
        )}
      </ScrollView>
    </Card>
  );
}
