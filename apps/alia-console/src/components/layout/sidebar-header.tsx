import * as React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { AiBrain01Icon, ArrowDown01Icon, Add01Icon, Tick02Icon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useWorkspace, type Workspace } from '@/hooks/use-workspace';
import { toast } from 'sonner';

export function SidebarHeaderBrand() {
  const { isMobile } = useSidebar();
  const { workspaces, currentWorkspace, setCurrentWorkspace, createWorkspace, isLoading } = useWorkspace();
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);

  const handleCreateWorkspace = () => {
    if (!newWorkspaceName.trim()) {
      toast.error('Please enter a workspace name');
      return;
    }

    setIsCreating(true);
    try {
      createWorkspace(newWorkspaceName.trim());
      toast.success(`Workspace "${newWorkspaceName.trim()}" created`);
      setShowCreateDialog(false);
      setNewWorkspaceName('');
    } catch {
      toast.error('Failed to create workspace');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectWorkspace = (workspace: Workspace) => {
    setCurrentWorkspace(workspace);
    toast.success(`Switched to ${workspace.name}`);
  };

  if (isLoading || !currentWorkspace) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" className="animate-pulse">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted" />
            <div className="grid flex-1 gap-1">
              <div className="h-4 w-24 bg-muted rounded" />
              <div className="h-3 w-16 bg-muted rounded" />
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  {currentWorkspace.type === 'personal' ? (
                    <HugeiconsIcon icon={AiBrain01Icon} size={18} />
                  ) : (
                    <HugeiconsIcon icon={UserMultiple02Icon} size={18} />
                  )}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{currentWorkspace.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {currentWorkspace.type === 'personal' ? 'Developer Portal' : 'Team Workspace'}
                  </span>
                </div>
                <HugeiconsIcon icon={ArrowDown01Icon} className="ml-auto" size={16} />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
              align="start"
              side={isMobile ? 'bottom' : 'right'}
              sideOffset={4}
            >
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Workspaces
              </DropdownMenuLabel>
              {workspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.id}
                  className="gap-2 p-2"
                  onClick={() => handleSelectWorkspace(workspace)}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border bg-primary text-primary-foreground">
                    {workspace.type === 'personal' ? (
                      <HugeiconsIcon icon={AiBrain01Icon} size={14} />
                    ) : (
                      <HugeiconsIcon icon={UserMultiple02Icon} size={14} />
                    )}
                  </div>
                  <span className="flex-1">{workspace.name}</span>
                  {currentWorkspace.id === workspace.id && (
                    <HugeiconsIcon icon={Tick02Icon} size={14} className="text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 p-2" onClick={() => setShowCreateDialog(true)}>
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <HugeiconsIcon icon={Add01Icon} size={14} />
                </div>
                <span className="text-muted-foreground font-medium">Create workspace</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>
              Create a new workspace to organize your apps and API keys. Team members can be added
              later.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="workspace-name" className="text-sm">
              Workspace name
            </Label>
            <Input
              id="workspace-name"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="My Team"
              className="mt-2"
              maxLength={50}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleCreateWorkspace();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateWorkspace} disabled={isCreating || !newWorkspaceName.trim()}>
              {isCreating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
