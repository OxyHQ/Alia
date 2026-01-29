import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  Delete02Icon,
  Add01Icon,
  UserMultiple02Icon,
  Mail01Icon,
  Cancel01Icon,
} from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useWorkspace,
  type WorkspaceRole,
  type WorkspaceMember,
  type WorkspaceInvite,
} from '@/hooks/use-workspace';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/settings/workspace')({
  component: WorkspaceSettingsPage,
});

const roleLabels: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const roleDescriptions: Record<WorkspaceRole, string> = {
  owner: 'Full access, can delete workspace',
  admin: 'Can manage members and settings',
  member: 'Can create apps and API keys',
  viewer: 'Read-only access',
};

function WorkspaceSettingsPage() {
  const {
    currentWorkspace,
    updateWorkspace,
    deleteWorkspace,
    inviteMember,
    removeMember,
    updateMemberRole,
    cancelInvite,
    canEditWorkspace,
    canManageMembers,
    canDeleteWorkspace,
  } = useWorkspace();

  const [name, setName] = useState(currentWorkspace?.name || '');
  const [description, setDescription] = useState(currentWorkspace?.description || '');
  const [isSaving, setIsSaving] = useState(false);

  // Invite dialog state
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('member');
  const [isInviting, setIsInviting] = useState(false);

  // Delete dialog state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  if (!currentWorkspace) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const canEdit = canEditWorkspace(currentWorkspace);
  const canManage = canManageMembers(currentWorkspace);
  const canDelete = canDeleteWorkspace(currentWorkspace);
  const isPersonal = currentWorkspace.type === 'personal';

  const handleSave = () => {
    if (!name.trim()) {
      toast.error('Workspace name is required');
      return;
    }

    setIsSaving(true);
    try {
      updateWorkspace(currentWorkspace.id, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      toast.success('Workspace updated');
    } catch {
      toast.error('Failed to update workspace');
    } finally {
      setIsSaving(false);
    }
  };

  const handleInvite = () => {
    if (!inviteEmail.trim()) {
      toast.error('Email is required');
      return;
    }

    setIsInviting(true);
    try {
      const invite = inviteMember(currentWorkspace.id, inviteEmail.trim(), inviteRole);
      if (invite) {
        toast.success(`Invite sent to ${inviteEmail}`);
        setShowInviteDialog(false);
        setInviteEmail('');
        setInviteRole('member');
      } else {
        toast.error('Failed to send invite');
      }
    } catch {
      toast.error('Failed to send invite');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = (member: WorkspaceMember) => {
    if (removeMember(currentWorkspace.id, member.id)) {
      toast.success(`${member.name || member.email} removed`);
    } else {
      toast.error('Failed to remove member');
    }
  };

  const handleRoleChange = (member: WorkspaceMember, role: WorkspaceRole) => {
    if (updateMemberRole(currentWorkspace.id, member.id, role)) {
      toast.success(`Role updated for ${member.name || member.email}`);
    } else {
      toast.error('Failed to update role');
    }
  };

  const handleCancelInvite = (invite: WorkspaceInvite) => {
    if (cancelInvite(currentWorkspace.id, invite.id)) {
      toast.success('Invite cancelled');
    } else {
      toast.error('Failed to cancel invite');
    }
  };

  const handleDelete = () => {
    if (deleteConfirmation !== currentWorkspace.name) {
      toast.error('Please type the workspace name to confirm');
      return;
    }

    if (deleteWorkspace(currentWorkspace.id)) {
      toast.success('Workspace deleted');
      setShowDeleteDialog(false);
    } else {
      toast.error('Failed to delete workspace');
    }
  };

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
          <div className="flex aspect-square size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HugeiconsIcon icon={UserMultiple02Icon} size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Workspace Settings</h1>
            <p className="text-sm text-muted-foreground">{currentWorkspace.name}</p>
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
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          )}
        </div>
      </div>

      {/* Team Members */}
      {!isPersonal && (
        <div className="px-6 py-6 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Team Members</h2>
            {canManage && (
              <Button size="sm" onClick={() => setShowInviteDialog(true)}>
                <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1.5" />
                Invite
              </Button>
            )}
          </div>

          {/* Members List */}
          <div className="space-y-2">
            {currentWorkspace.members?.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between py-3 px-4 rounded-lg border"
              >
                <div className="flex items-center gap-3">
                  <Avatar className="size-8">
                    <AvatarFallback>
                      {member.name?.[0]?.toUpperCase() || member.email[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium">{member.name || member.email}</p>
                    <p className="text-xs text-muted-foreground">{member.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {member.role === 'owner' ? (
                    <Badge variant="secondary">Owner</Badge>
                  ) : canManage ? (
                    <Select
                      value={member.role}
                      onValueChange={(value) => handleRoleChange(member, value as WorkspaceRole)}
                    >
                      <SelectTrigger className="w-28 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="viewer">Viewer</SelectItem>
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

          {/* Pending Invites */}
          {currentWorkspace.invites && currentWorkspace.invites.length > 0 && (
            <>
              <Separator className="my-4" />
              <h3 className="text-sm font-medium text-muted-foreground mb-3">Pending Invites</h3>
              <div className="space-y-2">
                {currentWorkspace.invites.map((invite) => (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between py-3 px-4 rounded-lg border border-dashed"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center size-8 rounded-full bg-muted">
                        <HugeiconsIcon icon={Mail01Icon} size={14} className="text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm">{invite.email}</p>
                        <p className="text-xs text-muted-foreground">
                          Invited as {roleLabels[invite.role]} •{' '}
                          {new Date(invite.invitedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCancelInvite(invite)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </>
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
              {currentWorkspace.billing?.credits?.toLocaleString() || 0} credits available
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
          <h2 className="text-sm font-semibold text-destructive mb-4">Danger Zone</h2>
          <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Delete workspace</p>
                <p className="text-xs text-muted-foreground">
                  This will permanently delete the workspace and all associated data.
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
                <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-1.5" />
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
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as WorkspaceRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">
                    <div>
                      <span className="font-medium">Admin</span>
                      <p className="text-xs text-muted-foreground">{roleDescriptions.admin}</p>
                    </div>
                  </SelectItem>
                  <SelectItem value="member">
                    <div>
                      <span className="font-medium">Member</span>
                      <p className="text-xs text-muted-foreground">{roleDescriptions.member}</p>
                    </div>
                  </SelectItem>
                  <SelectItem value="viewer">
                    <div>
                      <span className="font-medium">Viewer</span>
                      <p className="text-xs text-muted-foreground">{roleDescriptions.viewer}</p>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={isInviting || !inviteEmail.trim()}>
              {isInviting ? 'Sending...' : 'Send invite'}
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
              This action cannot be undone. This will permanently delete the workspace "
              {currentWorkspace.name}" and all associated data including apps and API keys.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="delete-confirm" className="text-sm">
              Type <span className="font-mono font-semibold">{currentWorkspace.name}</span> to
              confirm
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
            <AlertDialogCancel onClick={() => setDeleteConfirmation('')}>Cancel</AlertDialogCancel>
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
  );
}
