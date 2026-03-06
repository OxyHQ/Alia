import type { Workspace } from '@/hooks/use-workspace';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import config from '@/lib/config';
import { cn } from '@/lib/utils';

function resolveImageUrl(path: string): string {
  if (path.startsWith('http')) return path;
  return `${config.oxyUrl}/media/${path}`;
}

const sizeClasses = {
  sm: 'size-6 rounded-md text-[10px]',
  md: 'size-8 rounded-lg text-xs',
  lg: 'size-10 rounded-lg text-sm',
} as const;

interface WorkspaceAvatarProps {
  workspace: Workspace;
  user?: { avatar?: string; username?: string; name?: any } | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function WorkspaceAvatar({ workspace, user, size = 'md', className }: WorkspaceAvatarProps) {
  const sizeClass = sizeClasses[size];

  if (workspace.type === 'personal' && user) {
    const avatarUrl = user.avatar ? resolveImageUrl(user.avatar) : undefined;
    const initials = getUserInitials(user);

    return (
      <Avatar className={cn(sizeClass, className)}>
        <AvatarImage src={avatarUrl} alt="Personal Account" />
        <AvatarFallback className={cn(sizeClass, 'bg-primary text-primary-foreground')}>
          {initials}
        </AvatarFallback>
      </Avatar>
    );
  }

  const imageUrl = workspace.icon ? resolveImageUrl(workspace.icon) : undefined;
  const letter = workspace.name.charAt(0).toUpperCase() || 'W';

  return (
    <Avatar className={cn(sizeClass, className)}>
      <AvatarImage src={imageUrl} alt={workspace.name} />
      <AvatarFallback className={cn(sizeClass, 'bg-primary text-primary-foreground font-medium')}>
        {letter}
      </AvatarFallback>
    </Avatar>
  );
}

function getUserInitials(user: { username?: string; name?: any }): string {
  if (!user.name) return user.username?.[0]?.toUpperCase() || 'U';
  const name = user.name as { first?: string; last?: string };
  if (name.first && name.last) return `${name.first[0]}${name.last[0]}`.toUpperCase();
  return (name.first?.[0] || user.username?.[0] || 'U').toUpperCase();
}
