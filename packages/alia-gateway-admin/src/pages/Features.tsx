import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { apiClient } from '@/lib/api/client';
import { getErrorMessage } from '@/lib/utils';
import type { AdminFeature, AdminPlanFeature } from '@/types';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Plus, Save } from 'lucide-react';

// ─── Feature Form ────────────────────────────────────────────

interface FeatureFormState {
  featureId: string;
  label: string;
  description: string;
  icon: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
}

interface PlanFeatureMapping {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number | null;
  displayLabel?: string;
  displayDescription?: string;
}

const DEFAULT_FEATURE: FeatureFormState = {
  featureId: '',
  label: '',
  description: '',
  icon: '',
  category: 'Features',
  featureType: 'boolean',
  sortOrder: 0,
  isVisibleOnPricing: true,
  isActive: true,
};

// ─── Feature List Tab ────────────────────────────────────────

function FeatureListTab() {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selected, setSelected] = useState<AdminFeature | null>(null);
  const [form, setForm] = useState<FeatureFormState>(DEFAULT_FEATURE);

  const { data: featuresRes, isLoading } = useQuery({
    queryKey: ['features'],
    queryFn: () => apiClient.listFeatures() as Promise<{ success: boolean; data: AdminFeature[] }>,
    enabled: isAuthenticated,
  });
  const features = featuresRes?.data || [];

  const createMut = useMutation({
    mutationFn: (data: FeatureFormState) => apiClient.createFeature(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['features'] }); setEditOpen(false); },
    onError: (err: unknown) => alert(getErrorMessage(err, 'Failed')),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<FeatureFormState> }) => apiClient.updateFeature(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['features'] }); setEditOpen(false); },
    onError: (err: unknown) => alert(getErrorMessage(err, 'Failed')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiClient.deleteFeature(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['features'] }); setDeleteOpen(false); },
    onError: (err: unknown) => alert(getErrorMessage(err, 'Failed')),
  });

  const handleAdd = () => {
    setIsCreating(true);
    setForm(DEFAULT_FEATURE);
    setEditOpen(true);
  };

  const handleEdit = (f: AdminFeature) => {
    setIsCreating(false);
    setSelected(f);
    setForm({
      featureId: f.featureId,
      label: f.label,
      description: f.description || '',
      icon: f.icon || '',
      category: f.category,
      featureType: f.featureType,
      sortOrder: f.sortOrder,
      isVisibleOnPricing: f.isVisibleOnPricing,
      isActive: f.isActive,
    });
    setEditOpen(true);
  };

  const handleSave = () => {
    if (isCreating && !form.featureId.trim()) return alert('Feature ID is required');
    if (!form.label.trim()) return alert('Label is required');
    if (isCreating) {
      createMut.mutate(form);
    } else if (selected) {
      const { featureId, ...updates } = form;
      updateMut.mutate({ id: selected.featureId, data: updates });
    }
  };

  const isSaving = createMut.isPending || updateMut.isPending;

  // Group by category
  const categories = [...new Set(features.map(f => f.category))];

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">{features.length} features</p>
        <Button size="sm" onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-1" /> Add Feature
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Order</TableHead>
              <TableHead>Visible</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map(cat => (
              features.filter(f => f.category === cat).map(f => (
                <TableRow key={f._id}>
                  <TableCell className="font-mono text-xs">{f.featureId}</TableCell>
                  <TableCell className="font-medium">{f.label}</TableCell>
                  <TableCell><Badge variant="outline">{f.category}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={f.featureType === 'limit' ? 'default' : 'secondary'}>
                      {f.featureType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{f.sortOrder}</TableCell>
                  <TableCell>{f.isVisibleOnPricing ? 'Yes' : 'No'}</TableCell>
                  <TableCell>
                    <Badge variant={f.isActive ? 'default' : 'secondary'}>
                      {f.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(f)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setSelected(f); setDeleteOpen(true); }} className="text-destructive">Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            ))}
          </TableBody>
        </Table>
      )}

      {/* Edit/Create Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isCreating ? 'Create Feature' : `Edit: ${selected?.label}`}</DialogTitle>
            <DialogDescription>
              {isCreating ? 'Add a new feature definition.' : 'Update feature settings.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Feature ID</Label>
                <Input value={form.featureId} onChange={e => setForm({ ...form, featureId: e.target.value })} disabled={!isCreating} placeholder="web-search" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Label</Label>
                <Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Web Search" className="h-8 text-sm" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Optional description" className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Type</Label>
                <select value={form.featureType} onChange={e => setForm({ ...form, featureType: e.target.value as 'boolean' | 'limit' })} className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm">
                  <option value="boolean">Boolean</option>
                  <option value="limit">Limit</option>
                </select>
              </div>
              <div>
                <Label className="text-xs">Sort Order</Label>
                <Input type="number" value={form.sortOrder} onChange={e => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="h-8 text-sm" />
              </div>
            </div>
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <Switch checked={form.isVisibleOnPricing} onCheckedChange={v => setForm({ ...form, isVisibleOnPricing: v })} />
                <Label className="text-xs">Visible on Pricing</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.isActive} onCheckedChange={v => setForm({ ...form, isActive: v })} />
                <Label className="text-xs">Active</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>{isSaving ? 'Saving...' : isCreating ? 'Create' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Feature</AlertDialogTitle>
            <AlertDialogDescription>Delete <strong>{selected?.label}</strong>? This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => selected && deleteMut.mutate(selected.featureId)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleteMut.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Plan-Feature Matrix Tab ─────────────────────────────────

interface MatrixPlan {
  planId: string;
  name: string;
  product: string;
}

function MatrixTab() {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const { data: matrixRes, isLoading } = useQuery({
    queryKey: ['plan-features-matrix'],
    queryFn: () => apiClient.getPlanFeaturesMatrix() as Promise<{
      success: boolean;
      data: {
        features: AdminFeature[];
        plans: MatrixPlan[];
        mappings: Record<string, AdminPlanFeature>;
      };
    }>,
    enabled: isAuthenticated,
  });

  const matrix = matrixRes?.data;
  const features = matrix?.features || [];
  const plans = matrix?.plans || [];
  const serverMappings = matrix?.mappings || {};

  // Local state for edits
  const [localEdits, setLocalEdits] = useState<Record<string, { enabled: boolean; limitValue?: number; displayLabel?: string; displayDescription?: string }>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const getMapping = (planId: string, featureId: string) => {
    const key = `${planId}:${featureId}`;
    if (localEdits[key] !== undefined) return localEdits[key];
    const server = serverMappings[key];
    return server ? { enabled: server.enabled, limitValue: server.limitValue, displayLabel: server.displayLabel, displayDescription: server.displayDescription } : { enabled: false };
  };

  const toggleMapping = (planId: string, featureId: string) => {
    const key = `${planId}:${featureId}`;
    const current = getMapping(planId, featureId);
    setLocalEdits(prev => ({ ...prev, [key]: { ...current, enabled: !current.enabled } }));
    setHasChanges(true);
  };

  const setLimitValue = (planId: string, featureId: string, value: number) => {
    const key = `${planId}:${featureId}`;
    const current = getMapping(planId, featureId);
    setLocalEdits(prev => ({ ...prev, [key]: { ...current, limitValue: value } }));
    setHasChanges(true);
  };

  const bulkSaveMut = useMutation({
    mutationFn: async () => {
      // Build all mappings from server + local edits
      const allMappings: PlanFeatureMapping[] = [];
      for (const plan of plans) {
        for (const feat of features) {
          const m = getMapping(plan.planId, feat.featureId);
          allMappings.push({
            planId: plan.planId,
            featureId: feat.featureId,
            enabled: m.enabled,
            limitValue: m.limitValue,
            displayLabel: m.displayLabel,
            displayDescription: m.displayDescription,
          });
        }
      }
      return apiClient.bulkUpsertPlanFeatures(allMappings);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plan-features-matrix'] });
      setLocalEdits({});
      setHasChanges(false);
    },
    onError: (err: unknown) => alert(getErrorMessage(err, 'Failed to save')),
  });

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading matrix...</div>;
  }

  if (plans.length === 0 || features.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">No plans or features found. Create some first.</div>;
  }

  // Group features by category
  const categories = [...new Set(features.map(f => f.category))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {features.length} features x {plans.length} plans
        </p>
        <Button
          onClick={() => bulkSaveMut.mutate()}
          disabled={!hasChanges || bulkSaveMut.isPending}
          size="sm"
        >
          <Save className="h-4 w-4 mr-1" />
          {bulkSaveMut.isPending ? 'Saving...' : 'Save All'}
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[70vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background z-10 min-w-[200px]">Feature</TableHead>
              {plans.map(p => (
                <TableHead key={p.planId} className="text-center min-w-[100px]">
                  <div className="text-xs font-semibold">{p.name}</div>
                  <div className="text-[10px] text-muted-foreground">{p.product}</div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map(cat => (
              <>
                <TableRow key={`cat-${cat}`}>
                  <TableCell colSpan={plans.length + 1} className="bg-muted/50 py-1.5 sticky left-0">
                    <span className="text-xs font-semibold text-muted-foreground uppercase">{cat}</span>
                  </TableCell>
                </TableRow>
                {features.filter(f => f.category === cat).map(feat => (
                  <TableRow key={feat.featureId}>
                    <TableCell className="sticky left-0 bg-background z-10">
                      <div className="text-sm font-medium">{feat.label}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{feat.featureId}</div>
                    </TableCell>
                    {plans.map(plan => {
                      const mapping = getMapping(plan.planId, feat.featureId);
                      const isLimit = feat.featureType === 'limit';

                      return (
                        <TableCell key={plan.planId} className="text-center">
                          {isLimit ? (
                            <div className="flex flex-col items-center gap-1">
                              <input
                                type="checkbox"
                                checked={mapping.enabled}
                                onChange={() => toggleMapping(plan.planId, feat.featureId)}
                                className="rounded border-input"
                              />
                              {mapping.enabled && (
                                <Input
                                  type="number"
                                  value={mapping.limitValue ?? ''}
                                  onChange={e => setLimitValue(plan.planId, feat.featureId, parseInt(e.target.value) || 0)}
                                  className="h-6 w-16 text-xs text-center"
                                />
                              )}
                            </div>
                          ) : (
                            <input
                              type="checkbox"
                              checked={mapping.enabled}
                              onChange={() => toggleMapping(plan.planId, feat.featureId)}
                              className="rounded border-input"
                            />
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Features Page ───────────────────────────────────────────

export function FeaturesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Features</h2>
        <p className="text-muted-foreground">
          Manage feature definitions and plan-feature mappings.
        </p>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Feature List</TabsTrigger>
          <TabsTrigger value="matrix">Plan-Feature Matrix</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          <FeatureListTab />
        </TabsContent>

        <TabsContent value="matrix" className="mt-4">
          <MatrixTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
