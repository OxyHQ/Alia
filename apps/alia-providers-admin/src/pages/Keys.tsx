import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import { useRealtimeKeys } from '@/lib/websocket/hooks';
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
  RefreshCcw,
  Edit,
  Trash2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { PROVIDERS, type ProviderKey } from '@/types';

type KeyFormData = {
  name: string;
  provider: string;
  apiKey: string;
  isPaid: boolean;
  tier: string;
  priority: number;
  rateLimitResetMs?: number;
  rateLimit: {
    rps?: number;
    rpm?: number;
    rph?: number;
    rpd?: number;
    tps?: number;
    tpm?: number;
    tph?: number;
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
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);

  const [formData, setFormData] = useState<KeyFormData>({
    name: '',
    provider: 'openai',
    apiKey: '',
    isPaid: false,
    tier: 'free',
    priority: 1,
    rateLimit: {},
  });

  const [rotateKeyValue, setRotateKeyValue] = useState('');

  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  // Build filters object
  const filters: { provider?: string; active?: boolean } = {};
  if (filterProvider !== 'all') filters.provider = filterProvider;
  if (filterStatus === 'active') filters.active = true;
  if (filterStatus === 'archived') filters.active = false;

  // Real-time data subscription
  const { data: realtimeKeysData, isConnected } = useRealtimeKeys(filters);

  // Always fetch initial data via HTTP; slow-poll as fallback when WS is down
  const { data: polledKeysData, isLoading } = useQuery({
    queryKey: ['keys', filterProvider, filterStatus],
    queryFn: () => {
      const queryFilters: { provider?: string; active?: boolean } = {};
      if (filterProvider !== 'all') queryFilters.provider = filterProvider;
      if (filterStatus === 'active') queryFilters.active = true;
      if (filterStatus === 'archived') queryFilters.active = false;
      return apiClient.listKeys(queryFilters);
    },
    refetchInterval: isConnected ? false : 30000,
    enabled: isAuthenticated,
  });

  // Use real-time data if available, otherwise fall back to polled data
  const keysData = realtimeKeysData || polledKeysData;
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

  // Reload / Reset cooldowns mutation
  const reloadMutation = useMutation({
    mutationFn: () => apiClient.reloadKeys(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      const msg = `Reloaded: ${data.keyCount} active keys, ${data.cooldownsReset} cooldowns reset`;
      setReloadMessage(msg);
      setTimeout(() => setReloadMessage(null), 5000);
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      provider: 'openai',
      apiKey: '',
      isPaid: false,
      tier: 'free',
      priority: 1,
      rateLimitResetMs: undefined,
      rateLimit: {},
    });
  };

  const handleEdit = (key: ProviderKey) => {
    setSelectedKey(key);
    setFormData({
      name: key.name,
      provider: key.provider,
      apiKey: '',
      isPaid: key.isPaid,
      tier: key.tier || 'free',
      priority: key.originalPriority,
      rateLimitResetMs: key.rateLimitResetMs || undefined,
      rateLimit: key.rateLimit || {},
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
    // Remove empty rate limit values before sending
    const cleanRateLimit = Object.fromEntries(
      Object.entries(formData.rateLimit).filter(([_, v]) => v != null && v > 0)
    );
    if (isEditDialogOpen && selectedKey) {
      const updateData: Record<string, unknown> = {
        name: formData.name,
        isPaid: formData.isPaid,
        tier: formData.tier,
        priority: formData.priority,
        rateLimit: cleanRateLimit,
        rateLimitResetMs: formData.rateLimitResetMs || null,
      };
      if (formData.apiKey) {
        updateData.apiKey = formData.apiKey;
      }
      updateMutation.mutate({ keyId: selectedKey._id, data: updateData });
    } else {
      createMutation.mutate({ ...formData, rateLimit: cleanRateLimit });
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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => reloadMutation.mutate()}
            disabled={reloadMutation.isPending}
          >
            {reloadMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 h-4 w-4" />
            )}
            Reset Cooldowns
          </Button>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="isPaid"
                      checked={formData.isPaid}
                      onChange={(e) => setFormData({ ...formData, isPaid: e.target.checked })}
                      className="h-4 w-4"
                    />
                    <Label htmlFor="isPaid">Paid (fallback after free keys)</Label>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tier">Tier</Label>
                    <Select
                      value={formData.tier}
                      onValueChange={(value) => setFormData({ ...formData, tier: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="free">Free</SelectItem>
                        <SelectItem value="freemium">Freemium</SelectItem>
                        <SelectItem value="paid">Paid</SelectItem>
                        <SelectItem value="enterprise">Enterprise</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-3">
                  <Label className="text-sm font-semibold">Request Limits</Label>
                  <div className="grid grid-cols-4 gap-3">
                    {([['rps', '/sec'], ['rpm', '/min'], ['rph', '/hour'], ['rpd', '/day']] as const).map(([field, label]) => (
                      <div key={field} className="grid gap-1">
                        <Label htmlFor={`add-${field}`} className="text-xs text-muted-foreground">{label}</Label>
                        <Input
                          id={`add-${field}`}
                          type="number"
                          min="0"
                          placeholder="--"
                          value={formData.rateLimit[field] ?? ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              rateLimit: { ...formData.rateLimit, [field]: parseInt(e.target.value) || undefined },
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  <Label className="text-sm font-semibold">Token Limits</Label>
                  <div className="grid grid-cols-4 gap-3">
                    {([['tps', '/sec'], ['tpm', '/min'], ['tph', '/hour'], ['tpd', '/day']] as const).map(([field, label]) => (
                      <div key={field} className="grid gap-1">
                        <Label htmlFor={`add-${field}`} className="text-xs text-muted-foreground">{label}</Label>
                        <Input
                          id={`add-${field}`}
                          type="number"
                          min="0"
                          placeholder="--"
                          value={formData.rateLimit[field] ?? ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              rateLimit: { ...formData.rateLimit, [field]: parseInt(e.target.value) || undefined },
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rateLimitResetMs">Rate Limit Reset (ms)</Label>
                  <Input
                    id="rateLimitResetMs"
                    type="number"
                    min="0"
                    value={formData.rateLimitResetMs || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, rateLimitResetMs: parseInt(e.target.value) || undefined })
                    }
                    placeholder="e.g. 60000 for 1 min"
                  />
                  <p className="text-xs text-muted-foreground">
                    Fixed cooldown after rate limit errors. Leave empty for exponential backoff.
                  </p>
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
      </div>

      {/* Reload success message */}
      {reloadMessage && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{reloadMessage}</AlertDescription>
        </Alert>
      )}

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
                        <Badge variant={key.tier === 'free' ? 'outline' : 'default'}>
                          {key.tier ? key.tier.charAt(0).toUpperCase() + key.tier.slice(1) : (key.isPaid ? 'Paid' : 'Free')}
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
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="edit-isPaid"
                    checked={formData.isPaid}
                    onChange={(e) => setFormData({ ...formData, isPaid: e.target.checked })}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="edit-isPaid">Paid (fallback after free keys)</Label>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-tier">Tier</Label>
                  <Select
                    value={formData.tier}
                    onValueChange={(value) => setFormData({ ...formData, tier: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="free">Free</SelectItem>
                      <SelectItem value="freemium">Freemium</SelectItem>
                      <SelectItem value="paid">Paid</SelectItem>
                      <SelectItem value="enterprise">Enterprise</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-3">
                <Label className="text-sm font-semibold">Request Limits</Label>
                <div className="grid grid-cols-4 gap-3">
                  {([['rps', '/sec'], ['rpm', '/min'], ['rph', '/hour'], ['rpd', '/day']] as const).map(([field, label]) => (
                    <div key={field} className="grid gap-1">
                      <Label htmlFor={`edit-${field}`} className="text-xs text-muted-foreground">{label}</Label>
                      <Input
                        id={`edit-${field}`}
                        type="number"
                        min="0"
                        placeholder="--"
                        value={formData.rateLimit[field] ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            rateLimit: { ...formData.rateLimit, [field]: parseInt(e.target.value) || undefined },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                <Label className="text-sm font-semibold">Token Limits</Label>
                <div className="grid grid-cols-4 gap-3">
                  {([['tps', '/sec'], ['tpm', '/min'], ['tph', '/hour'], ['tpd', '/day']] as const).map(([field, label]) => (
                    <div key={field} className="grid gap-1">
                      <Label htmlFor={`edit-${field}`} className="text-xs text-muted-foreground">{label}</Label>
                      <Input
                        id={`edit-${field}`}
                        type="number"
                        min="0"
                        placeholder="--"
                        value={formData.rateLimit[field] ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            rateLimit: { ...formData.rateLimit, [field]: parseInt(e.target.value) || undefined },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-rateLimitResetMs">Rate Limit Reset (ms)</Label>
                <Input
                  id="edit-rateLimitResetMs"
                  type="number"
                  min="0"
                  value={formData.rateLimitResetMs || ''}
                  onChange={(e) =>
                    setFormData({ ...formData, rateLimitResetMs: parseInt(e.target.value) || undefined })
                  }
                  placeholder="e.g. 60000 for 1 min"
                />
                <p className="text-xs text-muted-foreground">
                  Fixed cooldown after rate limit errors. Leave empty for exponential backoff.
                </p>
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
