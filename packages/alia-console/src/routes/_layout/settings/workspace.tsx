import { Link, createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Delete02Icon,
  ImageUpload01Icon,
} from '@hugeicons/core-free-icons'
import { useAuth } from '@oxyhq/auth'
import { toast } from 'sonner'
import type { WorkspaceMember, WorkspaceRole } from '@/hooks/use-workspace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  canDeleteWorkspace as checkCanDelete,
  canEditWorkspace as checkCanEdit,
  canManageMembers as checkCanManage,
  useCurrentWorkspaceId,
  useDeleteWorkspace,
  useInviteMember,
  useRemoveMember,
  useUpdateMemberRole,
  useUpdateWorkspace,
  useUploadWorkspaceImage,
  useWorkspaceMembers,
  useWorkspaces,
} from '@/hooks/use-workspace'
import { WorkspaceAvatar } from '@/components/workspace-avatar'

export const Route = createFileRoute('/_layout/settings/workspace')({
  component: WorkspaceSettingsPage,
})

const roleLabels: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
}

const roleDescriptions: Record<WorkspaceRole, string> = {
  owner: 'Full access, can delete workspace',
  admin: 'Can manage members and settings',
  member: 'Can create apps and API keys',
}

function WorkspaceSettingsPage() {
  const { user, oxyServices } = useAuth()
  const { workspaces } = useWorkspaces()
  const [currentWorkspaceId, setCurrentWorkspaceId] = useCurrentWorkspaceId()
  const updateMutation = useUpdateWorkspace()
  const deleteMutation = useDeleteWorkspace()
  const inviteMutation = useInviteMember()
  const removeMutation = useRemoveMember()
  const roleChangeMutation = useUpdateMemberRole()
  const uploadImageMutation = useUploadWorkspaceImage()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const currentWorkspace =
    workspaces.find((w) => w.id === currentWorkspaceId) || workspaces[0] || null

  const { data: members, isLoading: membersLoading } = useWorkspaceMembers(
    currentWorkspace.id || '',
  )

  const [name, setName] = useState(currentWorkspace.name || '')
  const [description, setDescription] = useState(
    currentWorkspace.description || '',
  )

  // Invite dialog state
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('member')

  // Delete dialog state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')

  const userId = (user?._id as string) || (user?.id as string) || ''
  const canEdit = checkCanEdit(userId, currentWorkspace)
  const canManage = checkCanManage(userId, currentWorkspace)
  const canDelete = checkCanDelete(userId, currentWorkspace)
  const isPersonal = currentWorkspace.type === 'personal'

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Workspace name is required')
      return
    }

    try {
      await updateMutation.mutateAsync({
        id: currentWorkspace.id,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
        },
      })
      toast.success('Workspace updated')
    } catch {
      toast.error('Failed to update workspace')
    }
  }

  const handleInvite = async () => {
    if (!inviteEmail.trim()) {
      toast.error('Email is required')
      return
    }

    try {
      const result = await inviteMutation.mutateAsync({
        workspaceId: currentWorkspace.id,
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      if (result?.message) {
        toast.info(result.message)
      } else {
        toast.success(`Invite sent to ${inviteEmail}`)
      }
      setShowInviteDialog(false)
      setInviteEmail('')
      setInviteRole('member')
    } catch {
      toast.error('Failed to send invite')
    }
  }

  const handleRemoveMember = async (member: WorkspaceMember) => {
    try {
      await removeMutation.mutateAsync({
        workspaceId: currentWorkspace.id,
        memberId: member.id,
      })
      toast.success(`${member.name || member.email} removed`)
    } catch {
      toast.error('Failed to remove member')
    }
  }

  const handleRoleChange = async (
    member: WorkspaceMember,
    role: WorkspaceRole,
  ) => {
    try {
      await roleChangeMutation.mutateAsync({
        workspaceId: currentWorkspace.id,
        memberId: member.id,
        role,
      })
      toast.success(`Role updated for ${member.name || member.email}`)
    } catch {
      toast.error('Failed to update role')
    }
  }

  const handleDelete = async () => {
    if (deleteConfirmation !== currentWorkspace.name) {
      toast.error('Please type the workspace name to confirm')
      return
    }

    try {
      await deleteMutation.mutateAsync(currentWorkspace.id)
      setCurrentWorkspaceId('personal')
      toast.success('Workspace deleted')
      setShowDeleteDialog(false)
    } catch {
      toast.error('Failed to delete workspace')
    }
  }

  const displayMembers = members || currentWorkspace.members || []

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/dashboard"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Back to dashboard
        </Link>
        <div className="flex items-center gap-3">
          <WorkspaceAvatar workspace={currentWorkspace} user={user} size="lg" />
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Workspace Settings
            </h1>
            <p className="text-sm text-muted-foreground">
              {currentWorkspace.name}
            </p>
          </div>
        </div>
      </div>

      {/* General Settings */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground mb-4">General</h2>
        <div className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="name">Workspace name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit || isPersonal}
              maxLength={50}
            />
            {isPersonal && (
              <p className="text-xs text-muted-foreground">
                Personal workspace name cannot be changed
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              placeholder="A brief description of your workspace"
              rows={3}
            />
          </div>
          {canEdit && !isPersonal && (
            <>
              <div className="space-y-2">
                <Label>Workspace image</Label>
                <div className="flex items-center gap-4">
                  <WorkspaceAvatar
                    workspace={currentWorkspace}
                    user={user}
                    size="lg"
                    className="size-16 rounded-lg text-lg"
                  />
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadImageMutation.isPending}
                    >
                      <HugeiconsIcon
                        icon={ImageUpload01Icon}
                        size={14}
                        className="mr-1.5"
                      />
                      {uploadImageMutation.isPending
                        ? 'Uploading...'
                        : 'Upload image'}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1">
                      JPG, PNG, GIF or WebP. Max 2MB.
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        try {
                          await uploadImageMutation.mutateAsync({
                            workspaceId: currentWorkspace.id,
                            file,
                          })
                          toast.success('Workspace image updated')
                        } catch {
                          toast.error('Failed to upload image')
                        }
                        e.target.value = ''
                      }}
                    />
                  </div>
                </div>
              </div>
              <Button onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving...' : 'Save changes'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Team Members */}
      {!isPersonal && (
        <div className="px-6 py-6 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">
              Team Members
            </h2>
            {canManage && (
              <Button size="sm" onClick={() => setShowInviteDialog(true)}>
                <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1.5" />
                Invite
              </Button>
            )}
          </div>

          {/* Members List */}
          {membersLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-3 px-4 rounded-lg border animate-pulse"
                >
                  <div className="flex items-center gap-3">
                    <div className="size-8 rounded-full bg-muted" />
                    <div className="space-y-1">
                      <div className="h-4 w-24 bg-muted rounded" />
                      <div className="h-3 w-32 bg-muted rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {displayMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center justify-between py-3 px-4 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8">
                      {member.avatar && (
                        <AvatarImage
                          src={
                            member.avatar.startsWith('http')
                              ? member.avatar
                              : oxyServices.getFileDownloadUrl(
                                  member.avatar,
                                  'thumb',
                                )
                          }
                          alt={member.name || member.email}
                        />
                      )}
                      <AvatarFallback>
                        {(
                          member.name?.[0] ||
                          member.email?.[0] ||
                          '?'
                        ).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium">
                        {member.name || member.email}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {member.email}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {member.role === 'owner' ? (
                      <Badge variant="secondary">Owner</Badge>
                    ) : canManage ? (
                      <Select
                        value={member.role}
                        onValueChange={(value) =>
                          handleRoleChange(member, value as WorkspaceRole)
                        }
                      >
                        <SelectTrigger className="w-28 h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline">{roleLabels[member.role]}</Badge>
                    )}
                    {canManage && member.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => handleRemoveMember(member)}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Billing */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground mb-4">Billing</h2>
        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div>
            <p className="text-sm font-medium capitalize">
              {currentWorkspace.billing?.plan || 'Free'} Plan
            </p>
            <p className="text-xs text-muted-foreground">
              {currentWorkspace.billing?.credits.toLocaleString() || 0} credits
              available
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/billing">Manage billing</Link>
          </Button>
        </div>
      </div>

      {/* Danger Zone */}
      {canDelete && (
        <div className="px-6 py-6">
          <h2 className="text-sm font-semibold text-destructive mb-4">
            Danger Zone
          </h2>
          <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Delete workspace</p>
                <p className="text-xs text-muted-foreground">
                  This will permanently delete the workspace and all associated
                  data.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDeleteDialog(true)}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={14}
                  className="mr-1.5"
                />
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite team member</DialogTitle>
            <DialogDescription>
              Send an invitation to join this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as WorkspaceRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">
                    <div>
                      <span className="font-medium">Admin</span>
                      <p className="text-xs text-muted-foreground">
                        {roleDescriptions.admin}
                      </p>
                    </div>
                  </SelectItem>
                  <SelectItem value="member">
                    <div>
                      <span className="font-medium">Member</span>
                      <p className="text-xs text-muted-foreground">
                        {roleDescriptions.member}
                      </p>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInviteDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleInvite}
              disabled={inviteMutation.isPending || !inviteEmail.trim()}
            >
              {inviteMutation.isPending ? 'Sending...' : 'Send invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workspace</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              workspace "{currentWorkspace.name}" and all associated data
              including apps and API keys.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="delete-confirm" className="text-sm">
              Type{' '}
              <span className="font-mono font-semibold">
                {currentWorkspace.name}
              </span>{' '}
              to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              className="mt-2"
              placeholder={currentWorkspace.name}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirmation('')}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteConfirmation !== currentWorkspace.name}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}
