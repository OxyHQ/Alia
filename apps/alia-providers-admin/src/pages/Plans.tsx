import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import type { SubscriptionPlan, PlanFeatureGroup, PlanFeatureItem, AliaModel } from '@/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Plus, Trash2, PlusCircle, X } from 'lucide-react';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function featureCount(features: PlanFeatureGroup[]): string {
  const groups = features.length;
  const items = features.reduce((acc, g) => acc + g.items.length, 0);
  return `${groups} groups, ${items} items`;
}

// ─── Feature Groups Editor ──────────────────────────────────

function FeatureGroupsEditor({
  features,
  onChange,
}: {
  features: PlanFeatureGroup[];
  onChange: (f: PlanFeatureGroup[]) => void;
}) {
  const addGroup = () => {
    onChange([...features, { category: '', items: [] }]);
  };

  const removeGroup = (gi: number) => {
    onChange(features.filter((_, i) => i !== gi));
  };

  const updateGroupCategory = (gi: number, category: string) => {
    const updated = [...features];
    updated[gi] = { ...updated[gi], category };
    onChange(updated);
  };

  const addItem = (gi: number) => {
    const updated = [...features];
    updated[gi] = {
      ...updated[gi],
      items: [...updated[gi].items, { label: '' }],
    };
    onChange(updated);
  };

  const removeItem = (gi: number, fi: number) => {
    const updated = [...features];
    updated[gi] = {
      ...updated[gi],
      items: updated[gi].items.filter((_, i) => i !== fi),
    };
    onChange(updated);
  };

  const updateItem = (gi: number, fi: number, field: keyof PlanFeatureItem, value: string) => {
    const updated = [...features];
    updated[gi] = {
      ...updated[gi],
      items: updated[gi].items.map((item, i) =>
        i === fi ? { ...item, [field]: value || undefined } : item
      ),
    };
    onChange(updated);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Feature Groups</Label>
        <Button type="button" variant="outline" size="sm" onClick={addGroup}>
          <PlusCircle className="h-3.5 w-3.5 mr-1" />
          Add Group
        </Button>
      </div>

      {features.map((group, gi) => (
        <div key={gi} className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={group.category}
              onChange={(e) => updateGroupCategory(gi, e.target.value)}
              placeholder="Category name (e.g. Credits, Models, Features)"
              className="flex-1 h-8 text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeGroup(gi)}
              className="h-8 w-8 p-0 text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {group.items.map((item, fi) => (
            <div key={fi} className="flex items-start gap-2 pl-4">
              <div className="flex-1 space-y-1">
                <Input
                  value={item.label}
                  onChange={(e) => updateItem(gi, fi, 'label', e.target.value)}
                  placeholder="Feature label"
                  className="h-7 text-sm"
                />
                <Input
                  value={item.description || ''}
                  onChange={(e) => updateItem(gi, fi, 'description', e.target.value)}
                  placeholder="Description (optional)"
                  className="h-7 text-xs text-muted-foreground"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeItem(gi, fi)}
                className="h-7 w-7 p-0 text-destructive shrink-0 mt-0.5"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => addItem(gi)}
            className="ml-4 h-7 text-xs"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Item
          </Button>
        </div>
      ))}
    </div>
  );
}

// ─── Plan Form ──────────────────────────────────────────────

interface PlanFormState {
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  isFree: boolean;
  sortOrder: number;
  isActive: boolean;
  features: PlanFeatureGroup[];
  modelIds: string[];
  description: string;
  notes: string;
}

const DEFAULT_FORM: PlanFormState = {
  planId: '',
  name: '',
  product: 'alia',
  creditsPerMonth: 0,
  monthlyPrice: 0,
  annualPrice: 0,
  currency: 'usd',
  subtitle: '',
  creditsLabel: '',
  isFeatured: false,
  isFree: false,
  sortOrder: 0,
  isActive: true,
  features: [],
  modelIds: [],
  description: '',
  notes: '',
};

function planToForm(plan: SubscriptionPlan): PlanFormState {
  return {
    planId: plan.planId,
    name: plan.name,
    product: plan.product,
    creditsPerMonth: plan.creditsPerMonth,
    monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice,
    currency: plan.currency,
    subtitle: plan.subtitle || '',
    creditsLabel: plan.creditsLabel || '',
    isFeatured: plan.isFeatured,
    isFree: plan.isFree,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
    features: plan.features || [],
    modelIds: plan.modelIds || [],
    description: plan.description || '',
    notes: plan.notes || '',
  };
}

// ─── Plans Page ─────────────────────────────────────────────

export function PlansPage() {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('alia');

  // Dialogs
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan | null>(null);
  const [form, setForm] = useState<PlanFormState>(DEFAULT_FORM);

  // Query
  const { data: plansResponse, isLoading } = useQuery({
    queryKey: ['plans'],
    queryFn: () => apiClient.listPlans() as Promise<{ success: boolean; data: SubscriptionPlan[] }>,
    refetchInterval: 60000,
    enabled: isAuthenticated,
  });

  const { data: modelsResponse } = useQuery({
    queryKey: ['alia-models'],
    queryFn: () => apiClient.listAliaModels() as Promise<{ success: boolean; data: AliaModel[] }>,
    enabled: isAuthenticated,
  });
  const allModels = modelsResponse?.data || [];

  const plans = plansResponse?.data || [];
  const aliaPlans = plans.filter(p => p.product === 'alia').sort((a, b) => a.sortOrder - b.sortOrder);
  const codeaPlans = plans.filter(p => p.product === 'codea').sort((a, b) => a.sortOrder - b.sortOrder);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: PlanFormState) => apiClient.createPlan(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setEditOpen(false);
    },
    onError: (err: any) => alert(err?.response?.data?.error || err.message || 'Failed to create plan'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ planId, data }: { planId: string; data: Partial<PlanFormState> }) =>
      apiClient.updatePlan(planId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setEditOpen(false);
      setSelectedPlan(null);
    },
    onError: (err: any) => alert(err?.response?.data?.error || err.message || 'Failed to update plan'),
  });

  const deleteMutation = useMutation({
    mutationFn: (planId: string) => apiClient.deletePlan(planId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setDeleteOpen(false);
      setSelectedPlan(null);
    },
    onError: (err: any) => alert(err?.response?.data?.error || err.message || 'Failed to delete plan'),
  });

  // Handlers
  const handleAdd = () => {
    setIsCreating(true);
    setForm({ ...DEFAULT_FORM, product: activeTab as 'alia' | 'codea' });
    setEditOpen(true);
  };

  const handleEdit = (plan: SubscriptionPlan) => {
    setIsCreating(false);
    setSelectedPlan(plan);
    setForm(planToForm(plan));
    setEditOpen(true);
  };

  const handleDelete = (plan: SubscriptionPlan) => {
    setSelectedPlan(plan);
    setDeleteOpen(true);
  };

  const handleSave = () => {
    if (isCreating && !form.planId.trim()) {
      return alert('Plan ID is required');
    }
    if (!form.name.trim()) {
      return alert('Name is required');
    }
    if (form.creditsPerMonth < 0 || form.monthlyPrice < 0 || form.annualPrice < 0) {
      return alert('Credits and prices must not be negative');
    }

    // Strip empty feature groups/items
    const cleanedFeatures = form.features
      .filter(g => g.category.trim())
      .map(g => ({ ...g, items: g.items.filter(i => i.label.trim()) }));

    const cleanedForm = { ...form, features: cleanedFeatures };

    if (isCreating) {
      createMutation.mutate(cleanedForm);
    } else if (selectedPlan) {
      const { planId, ...updates } = cleanedForm;
      updateMutation.mutate({ planId: selectedPlan.planId, data: updates });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const renderTable = (plansList: SubscriptionPlan[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Plan ID</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Credits/mo</TableHead>
          <TableHead className="text-right">Monthly</TableHead>
          <TableHead className="text-right">Annual</TableHead>
          <TableHead>Features</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Order</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plansList.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
              No plans found
            </TableCell>
          </TableRow>
        ) : (
          plansList.map((plan) => (
            <TableRow key={plan._id}>
              <TableCell className="font-mono text-xs">{plan.planId}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{plan.name}</span>
                  {plan.isFeatured && <Badge variant="default" className="text-[10px]">Featured</Badge>}
                  {plan.isFree && <Badge variant="secondary" className="text-[10px]">Free</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono">
                {plan.creditsPerMonth.toLocaleString()}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCents(plan.monthlyPrice)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCents(plan.annualPrice)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {featureCount(plan.features)}
                {plan.modelIds?.length > 0 && (
                  <span className="block">{plan.modelIds.length} models</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={plan.isActive ? 'default' : 'secondary'}>
                  {plan.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">{plan.sortOrder}</TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleEdit(plan)}>
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleDelete(plan)}
                      className="text-destructive"
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Subscription Plans</h2>
          <p className="text-muted-foreground">
            Manage pricing, features, and display settings for Alia and Codea plans.
          </p>
        </div>
        <Button onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-2" />
          Add Plan
        </Button>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="alia">
            Alia Plans ({aliaPlans.length})
          </TabsTrigger>
          <TabsTrigger value="codea">
            Codea Plans ({codeaPlans.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="alia" className="mt-4">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading plans...</div>
          ) : (
            renderTable(aliaPlans)
          )}
        </TabsContent>

        <TabsContent value="codea" className="mt-4">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading plans...</div>
          ) : (
            renderTable(codeaPlans)
          )}
        </TabsContent>
      </Tabs>

      {/* Edit / Create Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isCreating ? 'Create Plan' : `Edit Plan: ${selectedPlan?.name}`}
            </DialogTitle>
            <DialogDescription>
              {isCreating
                ? 'Add a new subscription plan.'
                : 'Modify plan settings, pricing, and features.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Identity */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Identity</h4>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Plan ID</Label>
                  <Input
                    value={form.planId}
                    onChange={(e) => setForm({ ...form, planId: e.target.value })}
                    disabled={!isCreating}
                    placeholder="e.g. pro"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Pro"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Product</Label>
                  <select
                    value={form.product}
                    onChange={(e) => setForm({ ...form, product: e.target.value as 'alia' | 'codea' })}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    <option value="alia">Alia</option>
                    <option value="codea">Codea</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Pricing */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Pricing</h4>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs">Credits / Month</Label>
                  <Input
                    type="number"
                    value={form.creditsPerMonth}
                    onChange={(e) => setForm({ ...form, creditsPerMonth: parseInt(e.target.value) || 0 })}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Monthly (cents)</Label>
                  <Input
                    type="number"
                    value={form.monthlyPrice}
                    onChange={(e) => setForm({ ...form, monthlyPrice: parseInt(e.target.value) || 0 })}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Annual (cents)</Label>
                  <Input
                    type="number"
                    value={form.annualPrice}
                    onChange={(e) => setForm({ ...form, annualPrice: parseInt(e.target.value) || 0 })}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Currency</Label>
                  <Input
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Display */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Display</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Subtitle (i18n key)</Label>
                  <Input
                    value={form.subtitle}
                    onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                    placeholder="subscribe.proUsage"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Credits Label</Label>
                  <Input
                    value={form.creditsLabel}
                    onChange={(e) => setForm({ ...form, creditsLabel: e.target.value })}
                    placeholder="10,000 credits / mo"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Sort Order</Label>
                  <Input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2 pt-4">
                  <Switch
                    checked={form.isFeatured}
                    onCheckedChange={(v) => setForm({ ...form, isFeatured: v })}
                  />
                  <Label className="text-xs">Featured</Label>
                </div>
                <div className="flex items-center gap-2 pt-4">
                  <Switch
                    checked={form.isFree}
                    onCheckedChange={(v) => setForm({ ...form, isFree: v })}
                  />
                  <Label className="text-xs">Free Tier</Label>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.isActive}
                  onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                />
                <Label className="text-xs">Active</Label>
              </div>
            </div>

            {/* Models */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Models</h4>
              <p className="text-xs text-muted-foreground">
                Select which Alia models are included in this plan. A "Models" feature group is auto-generated on the billing API from these.
              </p>
              <div className="border rounded-lg p-3 space-y-1.5 max-h-48 overflow-y-auto">
                {allModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">No models loaded</p>
                ) : (
                  allModels
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                    .map((model) => {
                      const checked = form.modelIds.includes(model.aliasModelId);
                      return (
                        <label
                          key={model._id}
                          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setForm({
                                ...form,
                                modelIds: checked
                                  ? form.modelIds.filter((id) => id !== model.aliasModelId)
                                  : [...form.modelIds, model.aliasModelId],
                              });
                            }}
                            className="rounded border-input"
                          />
                          <span className="text-sm">{model.displayName}</span>
                          <span className="text-xs text-muted-foreground ml-auto font-mono">
                            {model.aliasModelId}
                          </span>
                          {!model.isActive && (
                            <Badge variant="secondary" className="text-[10px]">Inactive</Badge>
                          )}
                        </label>
                      );
                    })
                )}
              </div>
              {form.modelIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.modelIds.map((id) => {
                    const model = allModels.find((m) => m.aliasModelId === id);
                    return (
                      <Badge key={id} variant="outline" className="text-xs gap-1">
                        {model?.displayName || id}
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, modelIds: form.modelIds.filter((mid) => mid !== id) })}
                          className="ml-0.5 hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Features */}
            <FeatureGroupsEditor
              features={form.features}
              onChange={(features) => setForm({ ...form, features })}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : isCreating ? 'Create' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Plan</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the <strong>{selectedPlan?.name}</strong> plan?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => selectedPlan && deleteMutation.mutate(selectedPlan.planId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
