import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Copy01Icon, Delete02Icon, Settings01Icon } from '@hugeicons/core-free-icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  EnvironmentVariable,
  EnvironmentVariables,
  EnvironmentVariablesContent,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
} from '@/components/ui/environment-variables';
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
import { useApiKeys, useApp, useDeleteApiKey, useKeyUsage } from '@/hooks/use-developer';
import { ScrollArea } from '@/components/ui/scroll-area';

export const Route = createFileRoute('/_layout/apps/$appId/keys/$keyId')({
  component: KeyDetailPage,
});

function KeyDetailPage() {
  const navigate = useNavigate();
  const { appId, keyId } = Route.useParams();
  const { data: app } = useApp(appId);
  const { data: apiKeys = [] } = useApiKeys(appId);
  const { data: usage, isLoading: isLoadingUsage } = useKeyUsage(appId, keyId, '7d');
  const deleteKeyMutation = useDeleteApiKey();

  const [deleteDialog, setDeleteDialog] = useState(false);

  const apiKey = apiKeys.find((k) => k._id === keyId);
  const usageSummary = usage?.summary ?? {
    totalRequests: 0,
    totalTokens: 0,
    totalCredits: 0,
  };

  const handleCopyKeyPrefix = () => {
    navigator.clipboard.writeText(apiKey?.keyPrefix || '');
    toast.success('Key prefix copied to clipboard');
  };

  const handleDeleteKey = async () => {
    try {
      await deleteKeyMutation.mutateAsync({ appId, keyId });
      setDeleteDialog(false);
      navigate({ to: '/apps/$appId', params: { appId } });
      toast.success('API key deleted');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete API key');
    }
  };

  if (!apiKey) {
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
          to="/apps/$appId"
          params={{ appId }}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Back to {app?.name || 'app'}
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{apiKey.name}</h1>
            <p className="text-sm text-muted-foreground font-mono mt-1">{apiKey.keyPrefix}...</p>
          </div>
          <ButtonGroup>
            <Button variant="outline" size="sm" onClick={handleCopyKeyPrefix}>
              <HugeiconsIcon icon={Copy01Icon} size={14} className="mr-1.5" />
              Copy prefix
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/apps/$appId/settings" params={{ appId }}>
                <HugeiconsIcon icon={Settings01Icon} size={14} className="mr-1.5" />
                Settings
              </Link>
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {/* Key Details */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Details</p>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-1">Key ID</p>
            <p className="text-sm text-foreground font-mono">{apiKey._id}</p>
          </div>

          <div>
            <p className="text-sm text-muted-foreground mb-1">Status</p>
            <Badge variant={apiKey.isActive ? 'default' : 'secondary'}>
              {apiKey.isActive ? 'Active' : 'Inactive'}
            </Badge>
          </div>

          <div>
            <p className="text-sm text-muted-foreground mb-1">Created</p>
            <p className="text-sm text-foreground">
              {new Date(apiKey.createdAt).toLocaleDateString()}
            </p>
          </div>

          {apiKey.lastUsedAt && (
            <div>
              <p className="text-sm text-muted-foreground mb-1">Last used</p>
              <p className="text-sm text-foreground">
                {new Date(apiKey.lastUsedAt).toLocaleDateString()}
              </p>
            </div>
          )}

          {apiKey.expiresAt && (
            <div>
              <p className="text-sm text-muted-foreground mb-1">Expires</p>
              <p className="text-sm text-foreground">
                {new Date(apiKey.expiresAt).toLocaleDateString()}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Environment Variables */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Environment configuration</p>
        <EnvironmentVariables className="max-w-lg">
          <EnvironmentVariablesHeader>
            <EnvironmentVariablesTitle>API Key</EnvironmentVariablesTitle>
            <EnvironmentVariablesToggle />
          </EnvironmentVariablesHeader>
          <EnvironmentVariablesContent>
            <EnvironmentVariable name="ALIA_API_KEY" value={`${apiKey.keyPrefix}...`} />
            <EnvironmentVariable name="ALIA_BASE_URL" value="https://api.alia.onl/v1" />
          </EnvironmentVariablesContent>
        </EnvironmentVariables>
      </div>

      {/* Scopes */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Scopes</p>
        <div className="flex flex-wrap gap-2">
          {apiKey.scopes.map((scope) => (
            <Badge key={scope} variant="outline">
              {scope}
            </Badge>
          ))}
        </div>
      </div>

      {/* Usage Stats */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Usage (last 7 days)</p>
        {isLoadingUsage ? (
          <div className="animate-pulse flex flex-row gap-12">
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
          </div>
        ) : (
          <div className="flex flex-row gap-12">
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {usageSummary.totalRequests.toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Requests</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {usageSummary.totalTokens.toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Tokens</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {usageSummary.totalCredits.toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Credits</p>
            </div>
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-destructive mb-4">Danger zone</p>
        <Button variant="destructive" size="sm" onClick={() => setDeleteDialog(true)}>
          <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-1.5" />
          Delete key
        </Button>
      </div>

      {/* Delete Key Confirmation Dialog */}
      <AlertDialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{apiKey.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteKey}
              disabled={deleteKeyMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteKeyMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}
