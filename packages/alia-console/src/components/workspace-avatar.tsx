import type { JSX } from 'react'
import { useAuth } from '@oxyhq/services'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import type { Workspace } from '@/hooks/use-workspace'
import { cn } from '@/lib/utils'

type AvatarUser = {
  avatar?: string | null
  username?: string
  name?: { displayName?: string }
}

const sizeClasses = {
  sm: 'size-6 rounded-md text-[10px]',
  md: 'size-8 rounded-lg text-xs',
  lg: 'size-10 rounded-lg text-sm',
} as const

interface WorkspaceAvatarProps {
  workspace: Workspace
  user?: AvatarUser | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function WorkspaceAvatar({
  workspace,
  user,
  size = 'md',
  className,
}: WorkspaceAvatarProps): JSX.Element {
  const { oxyServices } = useAuth()
  const sizeClass = sizeClasses[size]

  const resolveImageUrl = (path: string): string =>
    path.startsWith('http') ? path : oxyServices.getFileDownloadUrl(path, 'thumb')

  if (workspace.type === 'personal' && user) {
    const avatarUrl = user.avatar ? resolveImageUrl(user.avatar) : undefined
    const initials = getUserInitials(user)

    return (
      <Avatar className={cn(sizeClass, className)}>
        <AvatarImage src={avatarUrl} alt="Personal Account" />
        <AvatarFallback
          className={cn(sizeClass, 'bg-primary text-primary-foreground')}
        >
          {initials}
        </AvatarFallback>
      </Avatar>
    )
  }

  const imageUrl = workspace.icon ? resolveImageUrl(workspace.icon) : undefined
  const letter = (workspace.name?.[0] || 'W').toUpperCase()

  return (
    <Avatar className={cn(sizeClass, className)}>
      <AvatarImage src={imageUrl} alt={workspace.name} />
      <AvatarFallback
        className={cn(
          sizeClass,
          'bg-primary text-primary-foreground font-medium',
        )}
      >
        {letter}
      </AvatarFallback>
    </Avatar>
  )
}

function getUserInitials(user: AvatarUser): string {
  return (user.name?.displayName?.[0] || user.username?.[0] || 'U').toUpperCase()
}
