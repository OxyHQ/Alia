import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Plus,
  MoreVertical,
  CheckCircle2,
  XCircle,
  Archive,
  RotateCw,
  Edit,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import type { ProviderKey } from '@/types';

const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'together',
  'cerebras',
  'cloudflare',
  'openrouter',
  'cohere',
];

type KeyFormData = {
  name: string;
  provider: string;
  apiKey: string;
  isPaid: boolean;
  priority: number;
  rateLimit: {
    rpm?: number;
    tpm?: number;
    rpd?: number;
    tpd?: number;
  };
};

export function KeysPage() {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isRotateDialogOpen, setIsRotateDialogOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<ProviderKey | null>(null);
  const [filterProvider, setFilterProvider] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const [formData, setFormData] = useState<KeyFormData>({
    name: '',
    provider: 'openai',
    apiKey: '',
    isPaid: false,
    priority: 1,
    rateLimit: {
      rpm: 500,
      tpm: 150000,
    },
  });

  const [rotateKeyValue, setRotateKeyValue] = useState('');

  const queryClient = useQueryClient();

  const { data: keysData, isLoading } = useQuery({
    queryKey: ['keys', filterProvider, filterStatus],
    queryFn: () => {
      const filters: any = {};
      if (filterProvider !== 'all') filters.provider = filterProvider;
      if (filterStatus === 'active') filters.isActive = true;
      if (filterStatus === 'archived') filters.isArchived = true;
      return apiClient.listKeys(filters);
    },
    refetchInterval: 30000,
  });

  const keys: ProviderKey[] = (keysData as any)?.data || [];

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: KeyFormData) => apiClient.createKey(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      setIsAddDialogOpen(false);
      resetForm();
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ keyId, data }: { keyId: string; data: Partial<KeyFormData> }) =>
      apiClient.updateKey(keyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      setIsEditDialogOpen(false);
      setSelectedKey(null);
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => apiClient.deleteKey(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      setIsDeleteDialogOpen(false);
      setSelectedKey(null);
    },
  });

  // Rotate mutation
  const rotateMutation = useMutation({
    mutationFn: ({ keyId, newKey }: { keyId: string; newKey: string }) =>
      apiClient.rotateKey(keyId, newKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      setIsRotateDialogOpen(false);
      setSelectedKey(null);
      setRotateKeyValue('');
    },
  });

  // Activate/Deactivate mutation
  const toggleActiveMutation = useMutation({
    mutationFn: ({ keyId, isActive }: { keyId: string; isActive: boolean }) =>
      apiClient.updateKey(keyId, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      provider: 'openai',
      apiKey: '',
      isPaid: false,
      priority: 1,
      rateLimit: {
        rpm: 500,
        tpm: 150000,
      },
    });
  };

  const handleEdit = (key: ProviderKey) => {
    setSelectedKey(key);
    setFormData({
      name: key.name,
      provider: key.provider,
      apiKey: '', // Don't show actual key
      isPaid: key.isPaid,
      priority: key.originalPriority,
      rateLimit: key.rateLimit,
    });
    setIsEditDialogOpen(true);
  };

  const handleDelete = (key: ProviderKey) => {
    setSelectedKey(key);
    setIsDeleteDialogOpen(true);
  };

  const handleRotate = (key: ProviderKey) => {
    setSelectedKey(key);
    setIsRotateDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditDialogOpen && selectedKey) {
      const updateData: any = {
        name: formData.name,
        isPaid: formData.isPaid,
        priority: formData.priority,
        rateLimit: formData.rateLimit,
      };
      // Only include apiKey if it's provided
      if (formData.apiKey) {
        updateData.apiKey = formData.apiKey;
      }
      updateMutation.mutate({ keyId: selectedKey._id, data: updateData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleRotateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedKey && rotateKeyValue) {
      rotateMutation.mutate({ keyId: selectedKey._id, newKey: rotateKeyValue });
    }
  };

  const handleToggleActive = (key: ProviderKey) => {
    toggleActiveMutation.mutate({ keyId: key._id, isActive: !key.isActive });
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">API Keys</h1>
          <p className="text-muted-foreground">
            Manage provider API keys with automatic rotation and monitoring
          </p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Key
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Add New API Key</DialogTitle>
                <DialogDescription>
                  Add a new provider API key to the rotation pool
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="OpenAI Key 1"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="provider">Provider</Label>
                    <Select
                      value={formData.provider}
                      onValueChange={(value) => setFormData({ ...formData, provider: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROVIDERS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p.charAt(0).toUpperCase() + p.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="priority">Priority</Label>
                    <Input
                      id="priority"
                      type="number"
                      min="1"
                      value={formData.priority}
                      onChange={(e) =>
                        setFormData({ ...formData, priority: parseInt(e.target.value) })
                      }
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="apiKey">API Key</Label>
                  <Textarea
                    id="apiKey"
                    value={formData.apiKey}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    placeholder="sk-..."
                    required
                    rows={3}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isPaid"
                    checked={formData.isPaid}
                    onChange={(e) => setFormData({ ...formData, isPaid: e.target.checked })}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="isPaid">Paid Tier (used as fallback after free keys)</Label>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="rpm">Requests Per Minute</Label>
                    <Input
                      id="rpm"
                      type="number"
                      min="0"
                      value={formData.rateLimit.rpm || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          rateLimit: { ...formData.rateLimit, rpm: parseInt(e.target.value) || undefined },
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tpm">Tokens Per Minute</Label>
                    <Input
                      id="tpm"
                      type="number"
                      min="0"
                      value={formData.rateLimit.tpm || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          rateLimit: { ...formData.rateLimit, tpm: parseInt(e.target.value) || undefined },
                        })
                      }
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Creating...' : 'Create Key'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            <div className="grid gap-2">
              <Label>Provider</Label>
              <Select value={filterProvider} onValueChange={setFilterProvider}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Providers</SelectItem>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active Only</SelectItem>
                  <SelectItem value="archived">Archived Only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Keys Table */}
      <Card>
        <CardHeader>
          <CardTitle>Keys ({keys.length})</CardTitle>
          <CardDescription>Manage and monitor your provider API keys</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No keys found. Add your first API key to get started.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Key Prefix</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Success Rate</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Failures</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => {
                  const successRate =
                    key.totalRequests > 0
                      ? ((key.successCount / key.totalRequests) * 100).toFixed(1)
                      : '0.0';

                  return (
                    <TableRow key={key._id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {key.isArchived ? (
                            <Archive className="h-4 w-4 text-gray-500" />
                          ) : key.isActive ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                          ) : (
                            <XCircle className="h-4 w-4 text-yellow-500" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell>{key.provider}</TableCell>
                      <TableCell>
                        <code className="text-xs">{key.keyPrefix}</code>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium">{key.currentPriority}</span>
                          {key.currentPriority !== key.originalPriority && (
                            <span className="text-xs text-muted-foreground">
                              (original: {key.originalPriority})
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={key.isPaid ? 'default' : 'outline'}>
                          {key.isPaid ? 'Paid' : 'Free'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className={successRate === '0.0' || parseFloat(successRate) < 80 ? 'text-red-500' : 'text-green-500'}>
                          {successRate}%
                        </span>
                      </TableCell>
                      <TableCell>{key.totalRequests}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm">{key.totalFailures}</span>
                          {key.consecutiveFailures > 0 && (
                            <span className="text-xs text-muted-foreground">
                              ({key.consecutiveFailures} consecutive)
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => handleEdit(key)}>
                              <Edit className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleRotate(key)}>
                              <RotateCw className="mr-2 h-4 w-4" />
                              Rotate Key
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleToggleActive(key)}
                              disabled={key.isArchived}
                            >
                              {key.isActive ? (
                                <>
                                  <XCircle className="mr-2 h-4 w-4" />
                                  Deactivate
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Activate
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDelete(key)}
                              className="text-red-600"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Edit API Key</DialogTitle>
              <DialogDescription>
                Update key configuration (leave API key empty to keep current)
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Provider</Label>
                  <Input value={formData.provider} disabled />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-priority">Priority</Label>
                  <Input
                    id="edit-priority"
                    type="number"
                    min="1"
                    value={formData.priority}
                    onChange={(e) =>
                      setFormData({ ...formData, priority: parseInt(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-apiKey">API Key (optional)</Label>
                <Textarea
                  id="edit-apiKey"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="Leave empty to keep current key"
                  rows={3}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="edit-isPaid"
                  checked={formData.isPaid}
                  onChange={(e) => setFormData({ ...formData, isPaid: e.target.checked })}
                  className="h-4 w-4"
                />
                <Label htmlFor="edit-isPaid">Paid Tier</Label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-rpm">Requests Per Minute</Label>
                  <Input
                    id="edit-rpm"
                    type="number"
                    min="0"
                    value={formData.rateLimit.rpm || ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rateLimit: { ...formData.rateLimit, rpm: parseInt(e.target.value) || undefined },
                      })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-tpm">Tokens Per Minute</Label>
                  <Input
                    id="edit-tpm"
                    type="number"
                    min="0"
                    value={formData.rateLimit.tpm || ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rateLimit: { ...formData.rateLimit, tpm: parseInt(e.target.value) || undefined },
                      })
                    }
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Updating...' : 'Update Key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rotate Dialog */}
      <Dialog open={isRotateDialogOpen} onOpenChange={setIsRotateDialogOpen}>
        <DialogContent>
          <form onSubmit={handleRotateSubmit}>
            <DialogHeader>
              <DialogTitle>Rotate API Key</DialogTitle>
              <DialogDescription>
                Replace the current API key with a new one. The old key will be invalidated.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  This will replace the key for: <strong>{selectedKey?.name}</strong>
                </AlertDescription>
              </Alert>
              <div className="grid gap-2">
                <Label htmlFor="rotate-key">New API Key</Label>
                <Textarea
                  id="rotate-key"
                  value={rotateKeyValue}
                  onChange={(e) => setRotateKeyValue(e.target.value)}
                  placeholder="sk-..."
                  required
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsRotateDialogOpen(false);
                  setRotateKeyValue('');
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={rotateMutation.isPending}>
                {rotateMutation.isPending ? 'Rotating...' : 'Rotate Key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this key? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This will permanently delete: <strong>{selectedKey?.name}</strong> (
              {selectedKey?.keyPrefix})
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => selectedKey && deleteMutation.mutate(selectedKey._id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
