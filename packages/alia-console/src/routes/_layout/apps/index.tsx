import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { getErrorMessage } from '@/lib/utils';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowRight01Icon,
  ChartLineData02Icon,
  Copy01Icon,
  Delete02Icon,
  Key01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
import { useApps, useCreateApp, useDeleteApp } from '@/hooks/use-developer';

export const Route = createFileRoute('/_layout/apps/')({
  component: AppsPage,
});

function AppsPage() {
  const navigate = useNavigate();
  const { data: apps = [], isLoading } = useApps();
  const createAppMutation = useCreateApp();
  const deleteAppMutation = useDeleteApp();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [deleteAppId, setDeleteAppId] = useState<string | null>(null);

  const handleCreateApp = async () => {
    if (!name.trim()) {
      toast.error('Please enter an app name');
      return;
    }

    try {
      const newApp = await createAppMutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
      });
      setShowCreateDialog(false);
      setName('');
      setDescription('');
      setWebsiteUrl('');
      toast.success('App created successfully');
      navigate({ to: '/apps/$appId', params: { appId: newApp._id } });
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to create app'));
    }
  };

  const handleDeleteApp = async () => {
    if (!deleteAppId) return;
    try {
      await deleteAppMutation.mutateAsync(deleteAppId);
      setDeleteAppId(null);
      toast.success('App deleted successfully');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to delete app'));
    }
  };

  const handleCopyAppId = (appId: string) => {
    navigator.clipboard.writeText(appId);
    toast.success('App ID copied to clipboard');
  };

  const handleOpenCreate = () => {
    setName('');
    setDescription('');
    setWebsiteUrl('');
    setShowCreateDialog(true);
  };

  const appToDelete = apps.find((app) => app._id === deleteAppId);

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">API Keys</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage your applications and API keys
            </p>
          </div>
          <Button size="sm" onClick={handleOpenCreate}>
            <HugeiconsIcon icon={Add01Icon} size={16} className="mr-2" />
            Create app
          </Button>
        </div>
      </div>

      {/* Apps List */}
      <div className="px-6">
        {isLoading ? (
          <div className="py-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="py-4 border-b border-border animate-pulse">
                <div className="h-4 w-32 bg-muted rounded mb-2" />
                <div className="h-3 w-48 bg-muted rounded" />
              </div>
            ))}
          </div>
        ) : apps.length === 0 ? (
          <div className="py-12 text-center">
            <HugeiconsIcon
              icon={Key01Icon}
              size={48}
              className="text-muted-foreground mx-auto mb-4"
            />
            <p className="text-sm font-medium text-foreground mb-1">No apps yet</p>
            <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
              Create your first application to generate API keys and start using the Alia API.
            </p>
            <Button size="sm" onClick={handleOpenCreate}>
              <HugeiconsIcon icon={Add01Icon} size={16} className="mr-2" />
              Create your first app
            </Button>
          </div>
        ) : (
          <div>
            {apps.map((app, index) => (
              <ContextMenu key={app._id}>
                <ContextMenuTrigger asChild>
                  <Link
                    to="/apps/$appId"
                    params={{ appId: app._id }}
                    className={`flex items-center justify-between py-4 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors ${
                      index < apps.length - 1 ? 'border-b border-border mx-0 px-0 rounded-none hover:bg-transparent hover:opacity-70' : ''
                    }`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{app.name}</p>
                        <Badge variant={app.isActive ? 'default' : 'secondary'} className="text-xs">
                          {app.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      {app.description && (
                        <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">
                          {app.description}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        Created {new Date(app.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      size={16}
                      className="text-muted-foreground ml-4"
                    />
                  </Link>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ to: '/apps/$appId', params: { appId: app._id } });
                    }}
                  >
                    <HugeiconsIcon icon={Key01Icon} className="mr-2 size-4" />
                    View Details
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ to: '/apps/$appId/settings', params: { appId: app._id } });
                    }}
                  >
                    <HugeiconsIcon icon={Settings01Icon} className="mr-2 size-4" />
                    Settings
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ to: '/apps/$appId/usage', params: { appId: app._id } });
                    }}
                  >
                    <HugeiconsIcon icon={ChartLineData02Icon} className="mr-2 size-4" />
                    Usage
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyAppId(app._id);
                    }}
                  >
                    <HugeiconsIcon icon={Copy01Icon} className="mr-2 size-4" />
                    Copy App ID
                    <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      setDeleteAppId(app._id);
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} className="mr-2 size-4" />
                    Delete
                    <ContextMenuShortcut>⌫</ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        )}
      </div>

      {/* Create App Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create app</DialogTitle>
            <DialogDescription>
              Create a new application to generate API keys and start using the Alia API.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm">
                Name *
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Awesome App"
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm">
                Description
              </Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of your app"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="websiteUrl" className="text-sm">
                Website URL
              </Label>
              <Input
                id="websiteUrl"
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateApp}
              disabled={createAppMutation.isPending || !name.trim()}
            >
              {createAppMutation.isPending ? 'Creating...' : 'Create app'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete App Confirmation */}
      <AlertDialog open={!!deleteAppId} onOpenChange={(open) => !open && setDeleteAppId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete app</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{appToDelete?.name}"? This will also delete all API
              keys and usage data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteApp}
              disabled={deleteAppMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteAppMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}
