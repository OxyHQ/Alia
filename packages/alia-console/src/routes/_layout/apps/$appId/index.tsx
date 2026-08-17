import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { getErrorMessage } from '@/lib/utils';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Delete02Icon,
} from '@hugeicons/core-free-icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { useApiKeys, useApp, useDeleteApp } from '@/hooks/use-developer';
import { IssuanceClosedNotice } from '@/components/issuance-closed-notice';
import { ScrollArea } from '@/components/ui/scroll-area';

export const Route = createFileRoute('/_layout/apps/$appId/')({
  component: AppDetailPage,
});

function AppDetailPage() {
  const navigate = useNavigate();
  const { appId } = Route.useParams();
  const { data: app, isLoading: isLoadingApp } = useApp(appId);
  const { data: apiKeys = [], isLoading: isLoadingKeys } = useApiKeys(appId);
  const deleteAppMutation = useDeleteApp();

  const [deleteAppDialog, setDeleteAppDialog] = useState(false);

  const handleDeleteApp = async () => {
    try {
      await deleteAppMutation.mutateAsync(appId);
      setDeleteAppDialog(false);
      navigate({ to: '/apps' });
      toast.success('App deleted successfully');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to delete app'));
    }
  };

  if (isLoadingApp || !app) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/apps"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Back to apps
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">{app.name}</h1>
        {app.description && (
          <p className="text-sm text-muted-foreground mt-1">{app.description}</p>
        )}
      </div>

      {/* App Details */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Details</p>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-1">App ID</p>
            <p className="text-sm text-foreground font-mono">{app._id}</p>
          </div>

          {app.websiteUrl && (
            <div>
              <p className="text-sm text-muted-foreground mb-1">Website</p>
              <p className="text-sm text-foreground">{app.websiteUrl}</p>
            </div>
          )}

          <div>
            <p className="text-sm text-muted-foreground mb-1">Status</p>
            <Badge variant={app.isActive ? 'default' : 'secondary'}>
              {app.isActive ? 'Active' : 'Inactive'}
            </Badge>
          </div>

          <div>
            <p className="text-sm text-muted-foreground mb-1">Created</p>
            <p className="text-sm text-foreground">
              {new Date(app.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </div>

      {/* Settings Link */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Settings</p>
        <Link
          to="/apps/$appId/settings"
          params={{ appId }}
          className="flex items-center justify-between py-3 hover:opacity-70 transition-opacity"
        >
          <p className="text-sm text-foreground">Edit app settings</p>
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
        </Link>
      </div>

      {/* API Keys */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">API keys</p>

        <IssuanceClosedNotice className="mb-4" />

        {isLoadingKeys ? (
          <p className="text-sm text-muted-foreground py-4">Loading keys...</p>
        ) : apiKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            This application has no API keys.
          </p>
        ) : (
          <div>
            {apiKeys.map((key, index) => (
              <Link
                key={key._id}
                to="/apps/$appId/keys/$keyId"
                params={{ appId, keyId: key._id }}
                className={`flex items-center justify-between py-3 hover:opacity-70 transition-opacity ${
                  index < apiKeys.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{key.name}</p>
                  <p className="text-sm text-muted-foreground font-mono">{key.keyPrefix}...</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt &&
                      ` • Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Usage Stats Link */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Analytics</p>
        <Link
          to="/apps/$appId/usage"
          params={{ appId }}
          className="flex items-center justify-between py-3 hover:opacity-70 transition-opacity"
        >
          <p className="text-sm text-foreground">View usage statistics</p>
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
        </Link>
      </div>

      {/* Danger Zone */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-destructive mb-4">Danger zone</p>
        <Button variant="destructive" size="sm" onClick={() => setDeleteAppDialog(true)}>
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-1.5" />
          Delete app
        </Button>
      </div>

      {/* Delete App Confirmation Dialog */}
      <AlertDialog open={deleteAppDialog} onOpenChange={setDeleteAppDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete app</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this app? This will also delete all API keys and
              usage data. This action cannot be undone.
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
