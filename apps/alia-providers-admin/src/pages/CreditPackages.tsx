import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import type { CreditPackage } from '@/types';
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
import { MoreHorizontal, Plus } from 'lucide-react';

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// ─── Package Form ────────────────────────────────────────────

interface PackageFormState {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  stripePriceId: string;
  sortOrder: number;
  isActive: boolean;
  description: string;
}

const DEFAULT_FORM: PackageFormState = {
  packageId: '',
  name: '',
  credits: 0,
  price: 0,
  currency: 'usd',
  stripePriceId: '',
  sortOrder: 0,
  isActive: true,
  description: '',
};

function packageToForm(pkg: CreditPackage): PackageFormState {
  return {
    packageId: pkg.packageId,
    name: pkg.name,
    credits: pkg.credits,
    price: pkg.price,
    currency: pkg.currency,
    stripePriceId: pkg.stripePriceId || '',
    sortOrder: pkg.sortOrder,
    isActive: pkg.isActive,
    description: pkg.description || '',
  };
}

// ─── Credit Packages Page ────────────────────────────────────

export function CreditPackagesPage() {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  // Dialogs
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<CreditPackage | null>(null);
  const [form, setForm] = useState<PackageFormState>(DEFAULT_FORM);

  // Query
  const { data: packagesResponse, isLoading } = useQuery({
    queryKey: ['credit-packages'],
    queryFn: () => apiClient.listCreditPackages() as Promise<{ success: boolean; data: CreditPackage[] }>,
    refetchInterval: 60000,
    enabled: isAuthenticated,
  });

  const packages = (packagesResponse?.data || []).sort((a, b) => a.sortOrder - b.sortOrder);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: PackageFormState) => apiClient.createCreditPackage(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credit-packages'] });
      setEditOpen(false);
    },
    onError: (err: any) => alert(err?.response?.data?.error || err.message || 'Failed to create package'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ packageId, data }: { packageId: string; data: Partial<PackageFormState> }) =>
      apiClient.updateCreditPackage(packageId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credit-packages'] });
      setEditOpen(false);
      setSelectedPackage(null);
    },
    onError: (err: any) => alert(err?.response?.data?.error || err.message || 'Failed to update package'),
  });

  const deleteMutation = useMutation({
    mutationFn: (packageId: string) => apiClient.deleteCreditPackage(packageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credit-packages'] });
      setDeleteOpen(false);
      setSelectedPackage(null);
    },
    onError: (err: any) => alert(err?.response?.data?.error || err.message || 'Failed to delete package'),
  });

  // Handlers
  const handleAdd = () => {
    setIsCreating(true);
    setForm({ ...DEFAULT_FORM });
    setEditOpen(true);
  };

  const handleEdit = (pkg: CreditPackage) => {
    setIsCreating(false);
    setSelectedPackage(pkg);
    setForm(packageToForm(pkg));
    setEditOpen(true);
  };

  const handleDelete = (pkg: CreditPackage) => {
    setSelectedPackage(pkg);
    setDeleteOpen(true);
  };

  const handleSave = () => {
    if (isCreating && !form.packageId.trim()) {
      return alert('Package ID is required');
    }
    if (!form.name.trim()) {
      return alert('Name is required');
    }
    if (form.credits < 0 || form.price < 0) {
      return alert('Credits and price must not be negative');
    }

    if (isCreating) {
      createMutation.mutate(form);
    } else if (selectedPackage) {
      const { packageId, ...updates } = form;
      updateMutation.mutate({ packageId: selectedPackage.packageId, data: updates });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Credit Packages</h2>
          <p className="text-muted-foreground">
            Manage one-time credit packages available for purchase.
          </p>
        </div>
        <Button onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-2" />
          Add Package
        </Button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading packages...</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Package ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Credits</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Stripe Price ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Order</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {packages.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No credit packages found
                </TableCell>
              </TableRow>
            ) : (
              packages.map((pkg) => (
                <TableRow key={pkg._id}>
                  <TableCell className="font-mono text-xs">{pkg.packageId}</TableCell>
                  <TableCell className="font-medium">{pkg.name}</TableCell>
                  <TableCell className="text-right font-mono">
                    {pkg.credits.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCents(pkg.price)}
                  </TableCell>
                  <TableCell className="uppercase text-xs">{pkg.currency}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {pkg.stripePriceId || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={pkg.isActive ? 'default' : 'secondary'}>
                      {pkg.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{pkg.sortOrder}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(pkg)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDelete(pkg)}
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
      )}

      {/* Edit / Create Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isCreating ? 'Create Package' : `Edit Package: ${selectedPackage?.name}`}
            </DialogTitle>
            <DialogDescription>
              {isCreating
                ? 'Add a new credit package.'
                : 'Modify package settings and pricing.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Identity */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Identity</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Package ID</Label>
                  <Input
                    value={form.packageId}
                    onChange={(e) => setForm({ ...form, packageId: e.target.value })}
                    disabled={!isCreating}
                    placeholder="e.g. credits-500"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. 500 Credits"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Pricing */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Pricing</h4>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Credits</Label>
                  <Input
                    type="number"
                    value={form.credits}
                    onChange={(e) => setForm({ ...form, credits: parseInt(e.target.value) || 0 })}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Price (cents)</Label>
                  <Input
                    type="number"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: parseInt(e.target.value) || 0 })}
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

            {/* Stripe */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Stripe Integration</h4>
              <div>
                <Label className="text-xs">Stripe Price ID</Label>
                <Input
                  value={form.stripePriceId}
                  onChange={(e) => setForm({ ...form, stripePriceId: e.target.value })}
                  placeholder="price_..."
                  className="h-8 text-sm"
                />
              </div>
            </div>

            {/* Display */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Display</h4>
              <div className="grid grid-cols-2 gap-3">
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
                    checked={form.isActive}
                    onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                  />
                  <Label className="text-xs">Active</Label>
                </div>
              </div>
              <div>
                <Label className="text-xs">Description (optional)</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Brief description of the package"
                  className="h-8 text-sm"
                />
              </div>
            </div>
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
            <AlertDialogTitle>Delete Package</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the <strong>{selectedPackage?.name}</strong> package?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => selectedPackage && deleteMutation.mutate(selectedPackage.packageId)}
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
