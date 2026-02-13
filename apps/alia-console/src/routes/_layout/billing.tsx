import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useCredits,
  useCreditPackages,
  useSubscription,
  useSubscriptionPlans,
  useCreateCheckout,
  useCreateSubscriptionCheckout,
  useTransactions,
} from '@/hooks/use-billing';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/billing')({
  component: BillingPage,
});

/** Format cents → "$3.99", dropping ".00" when even */
function formatPrice(cents: number, currency = 'usd'): string {
  const dollars = cents / 100;
  const formatted = dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2);
  const symbol = currency === 'usd' ? '$' : currency.toUpperCase() + ' ';
  return `${symbol}${formatted}`;
}

function BillingPage() {
  const { data: credits, isLoading: isLoadingCredits } = useCredits();
  const { data: packages = [], isLoading: isLoadingPackages } = useCreditPackages();
  const { data: subscription } = useSubscription('alia');
  const { data: plans = [] } = useSubscriptionPlans('alia');
  const { data: transactionsData, isLoading: isLoadingTransactions } = useTransactions();
  const createCheckout = useCreateCheckout();
  const createSubscriptionCheckout = useCreateSubscriptionCheckout();

  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'annual'>('monthly');

  const handlePurchase = async (packageId: string) => {
    try {
      const result = await createCheckout.mutateAsync({
        packageId,
        successUrl: `${window.location.origin}/billing?success=true`,
        cancelUrl: `${window.location.origin}/billing?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to create checkout session');
    }
  };

  const handleUpgrade = async (planId: string) => {
    try {
      const result = await createSubscriptionCheckout.mutateAsync({
        planId,
        billingPeriod,
        successUrl: `${window.location.origin}/billing?success=true`,
        cancelUrl: `${window.location.origin}/billing?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to create subscription checkout');
    }
  };

  const transactions = transactionsData?.transactions ?? [];

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your credits and subscription
        </p>
      </div>

      {/* Credit Balance */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Credit balance</p>
        {isLoadingCredits ? (
          <div className="animate-pulse flex flex-row gap-12">
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
          </div>
        ) : (
          <div className="flex flex-row gap-12">
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(credits?.credits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Total credits</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(credits?.freeCredits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Free credits</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(credits?.paidCredits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Paid credits</p>
            </div>
          </div>
        )}
      </div>

      {/* Current Plan */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Current plan</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-lg font-semibold text-foreground">
              {subscription?.plan?.name || 'Free Plan'}
            </p>
            <p className="text-sm text-muted-foreground">
              {subscription
                ? `${subscription.plan.creditsPerMonth.toLocaleString()} credits/month`
                : '300 free credits daily refresh'}
            </p>
          </div>
          {!subscription && (
            <Button variant="outline" size="sm" onClick={() => setShowUpgradeDialog(true)}>
              Upgrade plan
            </Button>
          )}
          {subscription && (
            <Badge variant={subscription.cancelAtPeriodEnd ? 'secondary' : 'default'}>
              {subscription.cancelAtPeriodEnd ? 'Cancels at period end' : 'Active'}
            </Badge>
          )}
        </div>
      </div>

      {/* Credit Packages */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Purchase credits</p>
        {isLoadingPackages ? (
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-muted rounded" />
            ))}
          </div>
        ) : packages.length > 0 ? (
          <div>
            {packages.map((pkg, index) => (
              <div
                key={pkg.id}
                className={`flex items-center justify-between py-4 ${
                  index < packages.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {pkg.credits.toLocaleString()} credits
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatPrice(pkg.price, pkg.currency)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePurchase(pkg.id)}
                  disabled={createCheckout.isPending}
                >
                  {createCheckout.isPending ? 'Loading...' : 'Purchase'}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4">
            No credit packages available at the moment.
          </p>
        )}
      </div>

      {/* Transaction History */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-foreground mb-4">Transaction history</p>
        {isLoadingTransactions ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-muted rounded" />
            ))}
          </div>
        ) : transactions.length > 0 ? (
          <div>
            {transactions.map((tx, index) => (
              <div
                key={tx._id}
                className={`flex items-center justify-between py-3 ${
                  index < transactions.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {tx.description || tx.type.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-foreground">
                    +{tx.credits.toLocaleString()} credits
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatPrice(tx.amount, tx.currency)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4">No transactions yet.</p>
        )}
      </div>

      {/* Upgrade Plan Dialog */}
      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Choose your plan</DialogTitle>
            <DialogDescription>
              All plans include Alia Chat + Codea (VS Code &amp; CLI). Credits are shared across all products.
            </DialogDescription>
          </DialogHeader>

          {/* Billing period toggle */}
          <div className="flex items-center justify-center gap-3 py-2">
            <button
              className={`text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${billingPeriod === 'monthly' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setBillingPeriod('monthly')}
            >
              Monthly
            </button>
            <button
              className={`text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${billingPeriod === 'annual' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setBillingPeriod('annual')}
            >
              Annual
              <span className="ml-1.5 text-[10px] font-semibold text-green-600">Save ~20%</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 py-4">
            {plans.filter(p => !p.isFree).map((plan) => {
              const isCurrentPlan = subscription?.plan?.planId === plan.id && subscription?.status === 'active';
              const isPopular = plan.isFeatured ?? false;
              const displayPrice = billingPeriod === 'annual'
                ? Math.round(plan.annualPrice / 12)
                : plan.monthlyPrice;
              return (
                <div
                  key={plan.id}
                  className={`relative flex flex-col p-4 border rounded-lg ${isPopular ? 'border-blue-500 border-2' : 'border-border'}`}
                >
                  {isPopular && (
                    <span className="absolute -top-2.5 left-3 bg-blue-500 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full">
                      Most popular
                    </span>
                  )}
                  <p className="text-sm font-semibold text-foreground">{plan.name}</p>
                  <p className="text-2xl font-bold text-foreground mt-1">
                    {formatPrice(displayPrice, plan.currency)}
                    <span className="text-xs font-normal text-muted-foreground">/mo</span>
                  </p>
                  {billingPeriod === 'annual' && (
                    <p className="text-[11px] text-muted-foreground">
                      {formatPrice(plan.annualPrice, plan.currency)}/year
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    {plan.creditsPerMonth.toLocaleString()} credits/month
                  </p>
                  <Button
                    size="sm"
                    variant={isPopular ? 'default' : 'outline'}
                    className="mt-3 w-full"
                    onClick={() => handleUpgrade(plan.id)}
                    disabled={isCurrentPlan || createSubscriptionCheckout.isPending}
                  >
                    {isCurrentPlan ? 'Current plan' : createSubscriptionCheckout.isPending ? 'Loading...' : 'Subscribe'}
                  </Button>
                </div>
              );
            })}
            {plans.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4 col-span-full">
                No subscription plans available at the moment.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUpgradeDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
