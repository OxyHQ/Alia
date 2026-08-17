import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { getErrorMessage } from '@/lib/utils';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  ChartLineData02Icon,
  Copy01Icon,
  Delete02Icon,
  Key01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { useApps, useDeleteApp } from '@/hooks/use-developer';
import { IssuanceClosedNotice } from '@/components/issuance-closed-notice';

export const Route = createFileRoute('/_layout/apps/')({
  component: AppsPage,
});

function AppsPage() {
  const navigate = useNavigate();
  const { data: apps = [], isLoading } = useApps();
  const deleteAppMutation = useDeleteApp();

  const [deleteAppId, setDeleteAppId] = useState<string | null>(null);

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

  const appToDelete = apps.find((app) => app._id === deleteAppId);

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">API Keys</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review and revoke your existing applications and API keys
            </p>
          </div>
        </div>
        <IssuanceClosedNotice className="mt-4" />
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
            <p className="text-sm font-medium text-foreground mb-1">No apps here</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Alia no longer registers developer applications. Register one in Oxy Console and call{' '}
              <span className="font-mono">api.oxy.so/v1</span>. This page lists applications Alia
              already holds, so you can review and revoke them.
            </p>
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
