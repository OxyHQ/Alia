import {
  useCancelSubscription,
  useCreateCheckout,
  useCreateCustomCheckout,
  useCreatePortalSession,
  useCreditPackages,
  useCreditPrice,
  useSubscription,
  useSubscriptionPolling,
  useTransactions,
} from '@/lib/hooks/use-billing';
import { useCredits } from '@/lib/hooks/use-credits';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import {
  SettingsGeneralPage,
  SettingsProfilePage,
  SettingsTextField,
  SettingsValueField,
  type SettingsPageSection,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { errorMessage as getErrorMessage } from '../../lib/errors/error-utils';

/** `$12.00` from integer cents. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface BillingSectionProps {
  success?: boolean;
}

export function BillingSection({ success }: BillingSectionProps) {
  const router = useRouter();
  const { data: creditsInfo, isLoading, refetch } = useCredits();
  const { data: subscription, refetch: refetchSubscription } =
    useSubscription();
  const { data: transactionsData, refetch: refetchTransactions } =
    useTransactions(10, 0);
  const { data: packages = [] } = useCreditPackages();
  const { data: creditPrice } = useCreditPrice();
  const cancelSubscriptionMutation = useCancelSubscription();
  const createPortalMutation = useCreatePortalSession();
  const createCheckoutMutation = useCreateCheckout();
  const createCustomCheckoutMutation = useCreateCustomCheckout();
  const [customCredits, setCustomCredits] = useState('');
  const { t } = useTranslation();

  const toastShown = useRef(false);

  const { data: polledSubscription } = useSubscriptionPolling(undefined, {
    enabled: !!success,
  });

  // Show success toast once subscription is confirmed via polling
  useEffect(() => {
    if (!success || toastShown.current) return;

    if (
      polledSubscription &&
      (polledSubscription.status === 'active' ||
        polledSubscription.status === 'trialing')
    ) {
      toastShown.current = true;
      refetch();
      refetchSubscription();
      refetchTransactions();
      toast.success(t('billing.paymentSuccess'));
      setTimeout(() => router.replace('/(app)/settings/usage'), 100);
    }
  }, [success, polledSubscription]);

  // Timeout fallback
  useEffect(() => {
    if (!success || toastShown.current) return;

    const timeout = setTimeout(() => {
      if (!toastShown.current) {
        toastShown.current = true;
        refetch();
        refetchSubscription();
        refetchTransactions();
        toast.success(t('billing.paymentSuccess'));
        setTimeout(() => router.replace('/(app)/settings/usage'), 100);
      }
    }, 32000);
    return () => clearTimeout(timeout);
  }, [success]);

  const handleCancelSubscription = async () => {
    try {
      await cancelSubscriptionMutation.mutateAsync();
      toast.success(t('billing.cancelSubscriptionSuccess'));
    } catch (error: unknown) {
      toast.error(
        getErrorMessage(error) || t('billing.failedCancelSubscription'),
      );
    }
  };

  const handleManagePayment = async () => {
    try {
      const url = await createPortalMutation.mutateAsync(
        Linking.createURL('/settings/usage'),
      );
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedPortal'));
    }
  };

  const isSubscribed = subscription && subscription.status === 'active';
  const freeCredits = creditsInfo
    ? creditsInfo.credits - creditsInfo.paidCredits
    : 0;

  const handlePurchaseCredits = async (packageId: string) => {
    try {
      const { url } = await createCheckoutMutation.mutateAsync({
        packageId,
        successUrl: Linking.createURL('/settings/usage?success=true'),
        cancelUrl: Linking.createURL('/settings/usage'),
      });
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedCheckout'));
    }
  };

  const parsedCustomCredits = parseInt(customCredits) || 0;
  const customPriceCents = creditPrice
    ? Math.round(parsedCustomCredits * creditPrice.pricePerCreditCents)
    : 0;
  const canBuyCustom =
    creditPrice &&
    parsedCustomCredits >= creditPrice.minCredits &&
    parsedCustomCredits <= creditPrice.maxCredits &&
    customPriceCents >= 50;

  const handleCustomPurchase = async () => {
    if (!canBuyCustom) return;
    try {
      const { url } = await createCustomCheckoutMutation.mutateAsync({
        credits: parsedCustomCredits,
        successUrl: Linking.createURL('/settings/usage?success=true'),
        cancelUrl: Linking.createURL('/settings/usage'),
      });
      if (url) {
        await Linking.openURL(url);
        setCustomCredits('');
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || t('billing.failedCheckout'));
    }
  };

  if (isLoading) {
    // The page's own geometry, shimmering: the plan card, then a card of rows.
    return (
      <View className="flex-1 gap-6">
        <Skeleton.Box width="100%" height={132} borderRadius={16} />
        <Skeleton.Box width="100%" height={156} borderRadius={16} />
      </View>
    );
  }

  if (!creditsInfo) {
    return (
      <SettingsProfilePage
        sections={[
          {
            key: 'error',
            rows: [{ key: 'error', label: t('billing.failedToLoad') }],
          },
        ]}
      />
    );
  }

  const renewal = isSubscribed
    ? subscription.cancelAtPeriodEnd
      ? t('billing.cancelsOn', {
          date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
        })
      : t('billing.renewsOn', {
          date: new Date(subscription.currentPeriodEnd).toLocaleDateString(),
        })
    : undefined;

  const plan = isSubscribed
    ? {
        badge: t('settings.account.currentPlan'),
        title: `${subscription.plan.name} ${dollars(subscription.plan.price)}${t('credits.perMonth')}`,
        description: `${t('billing.creditsPerMonth', {
          count: subscription.plan.creditsPerMonth.toLocaleString(),
        })} · ${renewal}`,
        /*
         * A complimentary plan is not billed and has no Stripe object behind
         * it, so both management actions are refused by the API with a 400.
         * They are not offered rather than offered-and-failing.
         */
        action: subscription.isComped ? undefined : (
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            onPress={() => router.push('/(biglayout)/subscribe')}
          >
            {t('billing.changePlan')}
          </Button>
        ),
      }
    : {
        badge: t('settings.account.currentPlan'),
        title: `${t('settings.account.billing.freePlan')} ${dollars(0)}${t('credits.perMonth')}`,
        description:
          creditsInfo.dailyRefresh > 0
            ? t('billing.creditsEvery24h', { count: creditsInfo.dailyRefresh })
            : t('settings.account.billing.freePlanDescription'),
        action: (
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            onPress={() => router.push('/(biglayout)/subscribe')}
          >
            {t('credits.upgrade')}
          </Button>
        ),
      };

  const sections: SettingsPageSection[] = [
    {
      key: 'credits',
      label: t('credits.credits'),
      rows: [
        {
          key: 'free',
          label: t('credits.freeCredits'),
          control: (
            <SettingsValueField>{`${freeCredits.toLocaleString()} / ${creditsInfo.freeLimit.toLocaleString()}`}</SettingsValueField>
          ),
        },
        ...(creditsInfo.paidCredits > 0
          ? [
              {
                key: 'paid',
                label: t('credits.paidCredits'),
                control: (
                  <SettingsValueField>
                    {creditsInfo.paidCredits.toLocaleString()}
                  </SettingsValueField>
                ),
              },
            ]
          : []),
        ...(creditsInfo.dailyRefresh > 0
          ? [
              {
                key: 'refresh',
                label: t('credits.dailyRefresh'),
                control: (
                  <SettingsValueField>{`+${creditsInfo.dailyRefresh}`}</SettingsValueField>
                ),
              },
            ]
          : []),
      ],
    },
  ];

  if (
    isSubscribed &&
    !subscription.isComped &&
    !subscription.cancelAtPeriodEnd
  ) {
    sections.push({
      key: 'subscription',
      label: t('settings.account.billing.subscription'),
      rows: [
        {
          key: 'cancel',
          label: t('billing.cancelSubscription'),
          description: renewal,
          control: (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              disabled={cancelSubscriptionMutation.isPending}
              loading={cancelSubscriptionMutation.isPending}
              onPress={handleCancelSubscription}
            >
              {cancelSubscriptionMutation.isPending
                ? t('billing.canceling')
                : t('billing.cancelSubscription')}
            </Button>
          ),
        },
      ],
    });
  }

  if (packages.length > 0) {
    sections.push({
      key: 'buy',
      label: t('credits.buyCredits'),
      description: t('credits.buyCreditsDescription'),
      rows: [
        ...packages.map((pkg) => ({
          key: pkg.id,
          label: pkg.name,
          description: t('credits.perThousand', {
            price: dollars((pkg.price / pkg.credits) * 1000),
          }),
          control: (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              disabled={createCheckoutMutation.isPending}
              onPress={() => handlePurchaseCredits(pkg.id)}
            >
              {dollars(pkg.price)}
            </Button>
          ),
        })),
        {
          key: 'custom',
          label: t('billing.customAmount'),
          description:
            parsedCustomCredits > 0
              ? t('settings.account.billing.customCredits', {
                  count: parsedCustomCredits.toLocaleString(),
                })
              : undefined,
          control: (
            <SettingsTextField
              label={t('billing.customAmountPlaceholder')}
              value={customCredits}
              onCommit={(text) => setCustomCredits(text.replace(/[^0-9]/g, ''))}
              placeholder={t('billing.customAmountPlaceholder')}
              keyboardType="numeric"
              autoComplete="off"
              showSavedToast={false}
            />
          ),
        },
        {
          key: 'custom-buy',
          label: t('billing.buy'),
          description:
            customPriceCents > 0 ? dollars(customPriceCents) : undefined,
          control: (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              onPress={handleCustomPurchase}
              disabled={!canBuyCustom || createCustomCheckoutMutation.isPending}
              loading={createCustomCheckoutMutation.isPending}
            >
              {customPriceCents > 0
                ? dollars(customPriceCents)
                : t('billing.buy')}
            </Button>
          ),
        },
      ],
    });
  }

  sections.push({
    key: 'payment',
    label: t('billing.paymentMethods'),
    rows: [
      {
        key: 'portal',
        label: t('billing.managePaymentMethods'),
        control: (
          <Button
            size="sm"
            leadingIcon={RiExternalLinkLine}
            appearance="outline"
            tone="neutral"
            disabled={createPortalMutation.isPending}
            loading={createPortalMutation.isPending}
            onPress={handleManagePayment}
          >
            {t('settings.account.manage')}
          </Button>
        ),
      },
    ],
  });

  if (transactionsData && transactionsData.transactions.length > 0) {
    sections.push({
      key: 'transactions',
      label: t('billing.recentTransactions'),
      rows: transactionsData.transactions.map((transaction) => ({
        key: transaction._id,
        label: transaction.description || transaction.type,
        description: `${new Date(transaction.createdAt).toLocaleDateString()} · ${dollars(transaction.amount)}`,
        control: (
          <SettingsValueField>{`+${transaction.credits.toLocaleString()}`}</SettingsValueField>
        ),
      })),
    });
  }

  return <SettingsGeneralPage plan={plan} sections={sections} />;
}
