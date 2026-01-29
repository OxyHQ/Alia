import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApp, useUpdateApp } from '@/hooks/use-developer';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/apps/$appId/settings')({
  component: AppSettingsPage,
});

function AppSettingsPage() {
  const navigate = useNavigate();
  const { appId } = Route.useParams();
  const { data: app, isLoading } = useApp(appId);
  const updateAppMutation = useUpdateApp();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');

  useEffect(() => {
    if (app) {
      setName(app.name);
      setDescription(app.description || '');
      setWebsiteUrl(app.websiteUrl || '');
    }
  }, [app]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }

    try {
      await updateAppMutation.mutateAsync({
        id: appId,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          websiteUrl: websiteUrl.trim() || undefined,
        },
      });
      toast.success('App updated successfully');
      navigate({ to: '/apps/$appId', params: { appId } });
    } catch (error: any) {
      toast.error(error.message || 'Failed to update app');
    }
  };

  if (isLoading || !app) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background max-w-2xl">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/apps/$appId"
          params={{ appId }}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Back to {app.name}
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">App settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Update your app configuration</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit}>
        <div className="px-6 py-6 border-b border-border">
          <p className="text-sm font-semibold text-foreground mb-4">General</p>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm">
                Name *
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Awesome App"
                required
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
        </div>

        <div className="px-6 py-6">
          <div className="flex gap-3">
            <Button type="submit" size="sm" disabled={updateAppMutation.isPending || !name.trim()}>
              {updateAppMutation.isPending ? 'Saving...' : 'Save changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate({ to: '/apps/$appId', params: { appId } })}
            >
              Cancel
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
