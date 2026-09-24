import { LibraryFile } from '@/lib/stores/library-store';
import { formatFileSize } from '@/lib/utils/format-file-size';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiFilePaper2Line } from '@oxy.so/bloom/icons/RiFilePaper2Line';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { Item } from '@oxy.so/bloom/item';

interface FileCardProps {
  file: LibraryFile;
  onPress?: (file: LibraryFile) => void;
  onDelete?: (file: LibraryFile) => void;
}

/** The glyph a file without a thumbnail is drawn with, by category. */
function categoryIcon(category: LibraryFile['category']) {
  if (category === 'images') return <RiImageLine size="sm" />;
  if (category === 'documents') return <RiFileTextLine size="sm" />;
  return <RiFilePaper2Line size="sm" />;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}

/** One Library file: a Bloom `Item` row with its thumbnail and its menu. */
export function FileCard({ file, onPress, onDelete }: FileCardProps) {
  const subtitle = [
    file.type.split('/').pop()?.toUpperCase(),
    file.size > 0 ? formatFileSize(file.size) : null,
    formatDate(file.createdAt),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Item
      role="listitem"
      onPress={() => onPress?.(file)}
      leading={
        <Avatar
          size={36}
          source={
            file.category === 'images' && file.thumbnail
              ? file.thumbnail
              : null
          }
          color="neutral"
          placeholderIcon={categoryIcon(file.category)}
          alt={file.name}
        />
      }
      title={file.name}
      subtitle={subtitle}
      trailing={
        <DropdownMenu>
          <DropdownMenuTrigger label="Actions" asChild>
            <Button
              icon={RiMoreFill}
              size="sm"
              tone="neutral"
              appearance="plain"
              accessibilityLabel={`Actions for ${file.name}`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              key="delete"
              tone="danger"
              onPress={() => onDelete?.(file)}
              leading={<RiDeleteBinLine size="sm" />}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
