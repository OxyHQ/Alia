import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { AdminTransaction, AdminSubscription } from '@/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function formatCents(cents: number, currency = 'usd'): string {
  const dollars = cents / 100;
  const formatted = dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2);
  return currency === 'usd' ? `$${formatted}` : `${formatted} ${currency.toUpperCase()}`;
}

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
    case 'active':
      return 'default';
    case 'pending':
    case 'trialing':
      return 'outline';
    case 'canceled':
    case 'past_due':
    case 'refunded':
      return 'secondary';
    case 'failed':
    case 'unpaid':
      return 'destructive';
    default:
      return 'outline';
  }
}

// ─── Transactions Tab ───────────────────────────────────────

function TransactionsTab() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-transactions', statusFilter, typeFilter],
    queryFn: () =>
      apiClient.listTransactions({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        type: typeFilter !== 'all' ? typeFilter : undefined,
        limit: 100,
      }) as Promise<{ success: boolean; data: AdminTransaction[]; total: number }>,
  });

  const transactions = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="refunded">Refunded</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="credit_purchase">Credit purchase</SelectItem>
            <SelectItem value="subscription_payment">Subscription</SelectItem>
            <SelectItem value="refund">Refund</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Credits</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No transactions found
                  </TableCell>
                </TableRow>
              ) : (
                transactions.map((tx) => (
                  <TableRow key={tx._id}>
                    <TableCell className="font-mono text-xs">{tx.oxyUserId}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{tx.type.replace(/_/g, ' ')}</Badge>
                    </TableCell>
                    <TableCell>{formatCents(tx.amount, tx.currency)}</TableCell>
                    <TableCell>{tx.credits.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(tx.status)}>{tx.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(tx.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {data && (
        <p className="text-xs text-muted-foreground">
          Showing {transactions.length} of {data.total} transactions
        </p>
      )}
    </div>
  );
}

// ─── Subscriptions Tab ──────────────────────────────────────

function SubscriptionsTab() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [productFilter, setProductFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-subscriptions', statusFilter, productFilter],
    queryFn: () =>
      apiClient.listSubscriptions({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        product: productFilter !== 'all' ? productFilter : undefined,
        limit: 100,
      }) as Promise<{ success: boolean; data: AdminSubscription[]; total: number }>,
  });

  const subscriptions = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="canceled">Canceled</SelectItem>
            <SelectItem value="past_due">Past due</SelectItem>
            <SelectItem value="trialing">Trialing</SelectItem>
          </SelectContent>
        </Select>
        <Select value={productFilter} onValueChange={setProductFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Product" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All products</SelectItem>
            <SelectItem value="alia">Alia</SelectItem>
            <SelectItem value="codea">Codea</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Period end</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No subscriptions found
                  </TableCell>
                </TableRow>
              ) : (
                subscriptions.map((sub) => (
                  <TableRow key={sub._id}>
                    <TableCell className="font-mono text-xs">{sub.oxyUserId}</TableCell>
                    <TableCell className="font-medium">{sub.plan.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{sub.plan.product}</Badge>
                    </TableCell>
                    <TableCell>{sub.billingPeriod || sub.plan.billingPeriod}</TableCell>
                    <TableCell>{formatCents(sub.plan.price, sub.plan.currency)}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(sub.status)}>
                        {sub.status}
                        {sub.cancelAtPeriodEnd ? ' (canceling)' : ''}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(sub.currentPeriodEnd).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {data && (
        <p className="text-xs text-muted-foreground">
          Showing {subscriptions.length} of {data.total} subscriptions
        </p>
      )}
    </div>
  );
}

// ─── Main Billing Page ──────────────────────────────────────

export function BillingPage() {
  const [activeTab, setActiveTab] = useState<'transactions' | 'subscriptions'>('subscriptions');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Billing</h2>
        <p className="text-muted-foreground">View transactions and subscriptions across all users.</p>
      </div>

      <div className="flex gap-1 border-b">
        <Button
          variant="ghost"
          size="sm"
          className={`rounded-none border-b-2 ${activeTab === 'subscriptions' ? 'border-primary' : 'border-transparent'}`}
          onClick={() => setActiveTab('subscriptions')}
        >
          Subscriptions
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={`rounded-none border-b-2 ${activeTab === 'transactions' ? 'border-primary' : 'border-transparent'}`}
          onClick={() => setActiveTab('transactions')}
        >
          Transactions
        </Button>
      </div>

      {activeTab === 'subscriptions' && <SubscriptionsTab />}
      {activeTab === 'transactions' && <TransactionsTab />}
    </div>
  );
}
