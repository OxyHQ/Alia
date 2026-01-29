import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCredits, useCreditPackages, useSubscription, useCreateCheckout } from '@/hooks/use-billing';

export const Route = createFileRoute('/_layout/billing')({
  component: BillingPage,
});

function BillingPage() {
  const { data: credits, isLoading: isLoadingCredits } = useCredits();
  const { data: packages = [], isLoading: isLoadingPackages } = useCreditPackages();
  const { data: subscription } = useSubscription();
  const createCheckout = useCreateCheckout();

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
    } catch (error) {
      console.error('Failed to create checkout:', error);
    }
  };

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
          <Button variant="outline" size="sm">
            Upgrade plan
          </Button>
        </div>
      </div>

      {/* Credit Packages */}
      <div className="px-6 py-6">
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
                    ${(pkg.price / 100).toFixed(2)} {pkg.currency.toUpperCase()}
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
          <div>
            {[
              { credits: 10000, price: '$10' },
              { credits: 50000, price: '$45' },
              { credits: 100000, price: '$80' },
            ].map((pkg, index) => (
              <div
                key={pkg.credits}
                className={`flex items-center justify-between py-4 ${index < 2 ? 'border-b border-border' : ''}`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {pkg.credits.toLocaleString()} credits
                  </p>
                  <p className="text-sm text-muted-foreground">{pkg.price}</p>
                </div>
                <Button variant="outline" size="sm" disabled>
                  Purchase
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
