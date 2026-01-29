import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Key01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useApps, useCreateApp } from '@/hooks/use-developer';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/apps/')({
  component: AppsPage,
});

function AppsPage() {
  const navigate = useNavigate();
  const { data: apps = [], isLoading } = useApps();
  const createAppMutation = useCreateApp();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');

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
    } catch (error: any) {
      toast.error(error.message || 'Failed to create app');
    }
  };

  const handleOpenCreate = () => {
    setName('');
    setDescription('');
    setWebsiteUrl('');
    setShowCreateDialog(true);
  };

  return (
    <div className="flex-1 bg-background">
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
              <Link
                key={app._id}
                to="/apps/$appId"
                params={{ appId: app._id }}
                className={`flex items-center justify-between py-4 hover:opacity-70 transition-opacity ${
                  index < apps.length - 1 ? 'border-b border-border' : ''
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
    </div>
  );
}
