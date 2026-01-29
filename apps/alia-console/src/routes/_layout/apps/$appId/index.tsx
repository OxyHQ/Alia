import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
} from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useApp, useApiKeys, useCreateApiKey, useDeleteApp } from '@/hooks/use-developer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/apps/$appId/')({
  component: AppDetailPage,
});

function AppDetailPage() {
  const navigate = useNavigate();
  const { appId } = Route.useParams();
  const { data: app, isLoading: isLoadingApp } = useApp(appId);
  const { data: apiKeys = [], isLoading: isLoadingKeys } = useApiKeys(appId);
  const createApiKeyMutation = useCreateApiKey();
  const deleteAppMutation = useDeleteApp();

  const [showNewKeyModal, setShowNewKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [deleteAppDialog, setDeleteAppDialog] = useState(false);

  const handleDeleteApp = async () => {
    try {
      await deleteAppMutation.mutateAsync(appId);
      setDeleteAppDialog(false);
      navigate({ to: '/apps' });
      toast.success('App deleted successfully');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete app');
    }
  };

  const handleCreateKey = async () => {
    if (!keyName.trim()) {
      toast.error('Please enter a key name');
      return;
    }

    try {
      const result = await createApiKeyMutation.mutateAsync({
        appId,
        data: {
          name: keyName.trim(),
          scopes: ['chat:read', 'chat:write', 'models:read'],
        },
      });

      setNewlyCreatedKey(result.apiKey.key || null);
      setShowNewKeyModal(false);
      setKeyName('');
      toast.success('API key created successfully');
    } catch (error: any) {
      toast.error(error.message || 'Failed to create API key');
    }
  };

  const handleCopyKey = async (key: string) => {
    await navigator.clipboard.writeText(key);
    toast.success('API key copied to clipboard');
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
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-foreground">API keys</p>
          <Button size="sm" onClick={() => setShowNewKeyModal(true)}>
            <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1.5" />
            Create key
          </Button>
        </div>

        {/* New Key Alert */}
        {newlyCreatedKey && (
          <div className="mb-4 p-4 rounded-md bg-yellow-500/10 border border-yellow-500/20">
            <p className="text-sm font-semibold text-yellow-500 mb-2">Save your API key</p>
            <p className="text-xs text-yellow-500/80 mb-3">
              Make sure to copy your API key now. You won't be able to see it again!
            </p>
            <button
              onClick={() => handleCopyKey(newlyCreatedKey)}
              className="flex items-center w-full p-2 rounded bg-yellow-500/10 hover:bg-yellow-500/20 transition-colors"
            >
              <span className="flex-1 text-sm font-mono text-yellow-500 truncate text-left">
                {newlyCreatedKey}
              </span>
              <HugeiconsIcon icon={Copy01Icon} size={16} className="text-yellow-500 ml-2" />
            </button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewlyCreatedKey(null)}
              className="mt-3"
            >
              I saved my key
            </Button>
          </div>
        )}

        {isLoadingKeys ? (
          <p className="text-sm text-muted-foreground py-4">Loading keys...</p>
        ) : apiKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No API keys yet. Create one to get started.
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

      {/* Create API Key Modal */}
      <Dialog open={showNewKeyModal} onOpenChange={setShowNewKeyModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give your API key a name to help you identify it later.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="keyName" className="text-sm">
              Key name
            </Label>
            <Input
              id="keyName"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Production Key"
              className="mt-2"
              maxLength={100}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewKeyModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateKey}
              disabled={createApiKeyMutation.isPending || !keyName.trim()}
            >
              {createApiKeyMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
