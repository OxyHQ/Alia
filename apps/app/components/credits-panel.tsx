import { useState, useMemo } from "react";
import { View, Pressable, ScrollView } from "react-native";
import * as Linking from "expo-linking";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, Calendar, X, Crown, MessageSquare, Layers, ShoppingCart } from "lucide-react-native";
import { useCredits, useCreditsUsage, useAnalytics, PERIODS, type UsagePeriod } from "@/lib/hooks/use-credits";
import { useSubscription, useCreditPackages, useCreateCheckout } from "@/lib/hooks/use-billing";
import { useRouter } from "expo-router";
import { useUIStore } from "@/lib/stores/ui-store";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";

function PeriodToggle({ value, onChange }: { value: UsagePeriod; onChange: (p: UsagePeriod) => void }) {
  return (
    <View className="flex-row bg-muted rounded-lg overflow-hidden">
      {PERIODS.map((p) => (
        <Pressable
          key={p}
          onPress={() => onChange(p)}
          className={`px-2 py-0.5 ${value === p ? "bg-background" : ""}`}
        >
          <Text className={`text-[10px] font-medium ${value === p ? "text-foreground" : "text-muted-foreground"}`}>
            {p}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function formatDayLabel(dateStr: string, isLast: boolean, todayLabel: string): string {
  if (isLast) return todayLabel;
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3);
}

function ChartSkeleton() {
  return (
    <View className="gap-3">
      <View className="gap-1">
        <Skeleton style={{ width: 60, height: 10 }} />
        <Skeleton style={{ width: 80, height: 20 }} />
      </View>
      <View className="flex-row items-end gap-1.5" style={{ height: 100 }}>
        {[40, 65, 30, 80, 55, 45, 70].map((h, i) => (
          <View key={i} className="flex-1 items-center gap-1.5">
            <View className="w-full items-center justify-end" style={{ height: 80 }}>
              <Skeleton className="w-full rounded-t-sm" style={{ height: `${h}%` }} />
            </View>
            <Skeleton style={{ width: 20, height: 8 }} />
          </View>
        ))}
      </View>
    </View>
  );
}

function UsageChart({ period }: { period: UsagePeriod }) {
  const { data: items = [], isLoading } = useCreditsUsage(period);
  const { t } = useTranslation();

  const { maxValue, totalUsed } = useMemo(() => {
    let max = 0, total = 0;
    for (const d of items) {
      if (d.used > max) max = d.used;
      total += d.used;
    }
    return { maxValue: max, totalUsed: total };
  }, [items]);

  if (isLoading) return <ChartSkeleton />;

  return (
    <View className="gap-3">
      <View>
        <Text className="text-xs text-muted-foreground">{t('credits.totalUsage')}</Text>
        <Text className="text-lg font-bold text-foreground">{totalUsed.toLocaleString()}</Text>
      </View>

      <View className="flex-row items-end gap-1.5" style={{ height: 100 }}>
        {totalUsed === 0 ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-xs text-muted-foreground">{t('credits.noUsage')}</Text>
          </View>
        ) : (
          items.map((item, i) => {
            const barHeight = maxValue > 0 ? (item.used / maxValue) * 100 : 0;
            const isLast = i === items.length - 1;
            return (
              <View key={item.date} className="flex-1 items-center gap-1.5">
                <View className="w-full items-center justify-end" style={{ height: 80 }}>
                  <View
                    className={`w-full rounded-t-sm ${isLast ? "bg-primary" : "bg-primary/30"}`}
                    style={{ height: `${Math.max(barHeight, 4)}%`, minHeight: 3 }}
                  />
                </View>
                <Text className={`text-[10px] ${isLast ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {formatDayLabel(item.date, isLast, t('credits.today'))}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

function CreditsSkeleton() {
  return (
    <View className="gap-5">
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Skeleton className="rounded-full" style={{ width: 18, height: 18 }} />
          <Skeleton style={{ width: 60, height: 14 }} />
        </View>
        <View className="flex-row items-baseline justify-between pl-6">
          <Skeleton style={{ width: 80, height: 12 }} />
          <Skeleton style={{ width: 100, height: 24 }} />
        </View>
      </View>
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Skeleton className="rounded-full" style={{ width: 18, height: 18 }} />
          <Skeleton style={{ width: 80, height: 14 }} />
        </View>
        <View className="flex-row items-baseline justify-between pl-6">
          <Skeleton style={{ width: 70, height: 12 }} />
          <Skeleton style={{ width: 40, height: 24 }} />
        </View>
      </View>
    </View>
  );
}

function ActivitySkeleton() {
  return (
    <View className="gap-5">
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Skeleton className="rounded-full" style={{ width: 18, height: 18 }} />
          <Skeleton style={{ width: 60, height: 14 }} />
        </View>
        <View className="flex-row items-baseline justify-between pl-6">
          <Skeleton style={{ width: 90, height: 12 }} />
          <Skeleton style={{ width: 50, height: 24 }} />
        </View>
        <View className="flex-row items-baseline justify-between pl-6">
          <Skeleton style={{ width: 75, height: 12 }} />
          <Skeleton style={{ width: 45, height: 16 }} />
        </View>
      </View>
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Skeleton className="rounded-full" style={{ width: 18, height: 18 }} />
          <Skeleton style={{ width: 55, height: 14 }} />
        </View>
        <View className="pl-6 gap-1.5">
          <View className="flex-row items-baseline justify-between">
            <Skeleton style={{ width: 90, height: 12 }} />
            <Skeleton style={{ width: 20, height: 12 }} />
          </View>
          <View className="flex-row items-baseline justify-between">
            <Skeleton style={{ width: 70, height: 12 }} />
            <Skeleton style={{ width: 20, height: 12 }} />
          </View>
        </View>
      </View>
    </View>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString();
}

export function CreditsPanel() {
  const router = useRouter();
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const { data, isLoading: creditsLoading } = useCredits();
  const { data: subscription } = useSubscription();
  const { data: packages = [] } = useCreditPackages();
  const createCheckoutMutation = useCreateCheckout();
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics(period);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const { t } = useTranslation();

  const { totalConversations, totalTokens } = useMemo(() => {
    const usage = analytics?.usage;
    if (!usage) return { totalConversations: 0, totalTokens: 0 };
    let convs = 0, tokens = 0;
    for (const d of usage) {
      convs += d.conversations;
      tokens += d.totalTokens;
    }
    return { totalConversations: convs, totalTokens: tokens };
  }, [analytics?.usage]);

  const credits = data?.credits ?? 0;
  const freeLimit = data?.freeLimit ?? 0;
  const paidCredits = data?.paidCredits ?? 0;
  const dailyRefresh = data?.dailyRefresh ?? 0;
  const isSubscribed = subscription?.status === 'active';

  const navigate = (path: string) => {
    setRightPanel(null);
    router.push(path as any);
  };

  const handlePurchaseCredits = async (packageId: string) => {
    try {
      const { url } = await createCheckoutMutation.mutateAsync({
        packageId,
        successUrl: Linking.createURL("/settings/usage?success=true"),
        cancelUrl: Linking.createURL("/settings/usage"),
      });
      if (url) {
        await Linking.openURL(url);
      }
    } catch (error: any) {
      toast.error(error.message || t('billing.failedCheckout'));
    }
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          {t('credits.title')}
        </Text>
        <Pressable className="p-1 rounded-lg active:opacity-70" onPress={() => setRightPanel(null)}>
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Plan Badge & Upgrade */}
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-2">
            <View className={`px-2 py-0.5 rounded-full ${isSubscribed ? 'bg-primary/10' : 'bg-muted'}`}>
              {isSubscribed ? (
                <Text className="text-xs font-medium text-primary">{subscription.plan.name}</Text>
              ) : (
                <Text className="text-xs font-medium text-muted-foreground">{t('credits.free')}</Text>
              )}
            </View>
          </View>
          <Button onPress={() => navigate(isSubscribed ? "/(app)/settings/usage" : "/(biglayout)/subscribe")} className="h-8 px-4 rounded-full">
            <Text className="text-sm font-medium text-primary-foreground">
              {isSubscribed ? t('credits.manageBilling') : t('credits.upgrade')}
            </Text>
          </Button>
        </View>

        {/* Credits Section */}
        <View className="p-4">
          {creditsLoading ? (
            <CreditsSkeleton />
          ) : (
            <View className="gap-5">
              <View className="gap-2">
                <View className="flex-row items-center gap-2">
                  <Sparkles size={18} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">{t('credits.credits')}</Text>
                </View>
                <View className="flex-row items-baseline justify-between pl-6">
                  <Text className="text-sm text-muted-foreground">{t('credits.freeCredits')}</Text>
                  <View className="flex-row items-baseline gap-1">
                    <Text className="text-2xl font-bold text-foreground">
                      {(credits - paidCredits).toLocaleString()}
                    </Text>
                    <Text className="text-sm text-muted-foreground">/ {freeLimit.toLocaleString()}</Text>
                  </View>
                </View>
                {paidCredits > 0 && (
                  <View className="flex-row items-baseline justify-between pl-6">
                    <Text className="text-sm text-muted-foreground">{t('credits.paidCredits')}</Text>
                    <Text className="text-base font-semibold text-foreground">{paidCredits.toLocaleString()}</Text>
                  </View>
                )}
              </View>

              {isSubscribed && (
                <View className="gap-2">
                  <View className="flex-row items-center gap-2">
                    <Crown size={18} className="text-foreground" />
                    <Text className="text-sm font-semibold text-foreground">{t('credits.subscription')}</Text>
                  </View>
                  <View className="pl-6 gap-1">
                    <View className="flex-row items-baseline justify-between">
                      <Text className="text-sm text-muted-foreground">{subscription.plan.name}</Text>
                      <Text className="text-base font-semibold text-foreground">
                        ${(subscription.plan.price / 100).toFixed(2)}{t('credits.perMonth')}
                      </Text>
                    </View>
                    <Text className="text-xs text-muted-foreground">
                      {t('credits.creditsPerMonth', { count: subscription.plan.creditsPerMonth.toLocaleString() })}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {subscription.cancelAtPeriodEnd
                        ? t('credits.cancelsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })
                        : t('credits.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString() })}
                    </Text>
                  </View>
                </View>
              )}

              <View className="gap-2">
                <View className="flex-row items-center gap-2">
                  <Calendar size={18} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">{t('credits.dailyRefresh')}</Text>
                </View>
                <View className="flex-row items-baseline justify-between pl-6">
                  <Text className="text-sm text-muted-foreground">{t('credits.atMidnight')}</Text>
                  <Text className="text-2xl font-bold text-foreground">{dailyRefresh}</Text>
                </View>
              </View>
            </View>
          )}
        </View>

        {/* Usage Chart */}
        <View className="px-4 pb-3 border-b border-border">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-xs font-medium text-muted-foreground">{t('credits.creditUsage')}</Text>
            <PeriodToggle value={period} onChange={setPeriod} />
          </View>
          <UsageChart period={period} />
        </View>

        {/* Buy Credits */}
        {packages.length > 0 && (
          <View className="px-4 pb-4">
            <View className="border border-border rounded-xl p-3">
              <View className="flex-row items-center gap-2 mb-2">
                <ShoppingCart size={14} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-muted-foreground">{t('credits.buyCredits')}</Text>
              </View>
              <View className="gap-2">
                {packages.map((pkg) => (
                  <Pressable
                    key={pkg.id}
                    onPress={() => handlePurchaseCredits(pkg.id)}
                    disabled={createCheckoutMutation.isPending}
                    className="flex-row items-center justify-between py-2 px-3 rounded-lg border border-border bg-background active:bg-muted"
                  >
                    <View>
                      <Text className="text-sm font-medium text-foreground">{pkg.name}</Text>
                      <Text className="text-[10px] text-muted-foreground">
                        {t('credits.perThousand', { price: `$${((pkg.price / pkg.credits) * 1000 / 100).toFixed(2)}` })}
                      </Text>
                    </View>
                    <Text className="text-sm font-semibold text-foreground">
                      ${(pkg.price / 100).toFixed(2)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* Activity & Models */}
        <View className="p-4">
          {analyticsLoading ? (
            <ActivitySkeleton />
          ) : (
            <View className="gap-5">
              <View className="gap-2">
                <View className="flex-row items-center gap-2">
                  <MessageSquare size={18} className="text-foreground" />
                  <Text className="text-sm font-semibold text-foreground">{t('credits.activity')}</Text>
                </View>
                {totalConversations > 0 ? (
                  <>
                    <View className="flex-row items-baseline justify-between pl-6">
                      <Text className="text-sm text-muted-foreground">{t('credits.conversations')}</Text>
                      <Text className="text-2xl font-bold text-foreground">{totalConversations.toLocaleString()}</Text>
                    </View>
                    <View className="flex-row items-baseline justify-between pl-6">
                      <Text className="text-sm text-muted-foreground">{t('credits.tokensUsed')}</Text>
                      <Text className="text-base font-semibold text-foreground">{formatTokens(totalTokens)}</Text>
                    </View>
                  </>
                ) : (
                  <Text className="text-xs text-muted-foreground pl-6">{t('credits.noActivity')}</Text>
                )}
              </View>

              {analytics && analytics.models.length > 0 && (
                <View className="gap-2">
                  <View className="flex-row items-center gap-2">
                    <Layers size={18} className="text-foreground" />
                    <Text className="text-sm font-semibold text-foreground">{t('credits.models')}</Text>
                  </View>
                  <View className="pl-6 gap-1">
                    {analytics.models.map((m) => (
                      <View key={m._id} className="flex-row items-baseline justify-between">
                        <Text className="text-sm text-muted-foreground">
                          {m.emoji ? `${m.emoji} ` : ''}{m.name}
                        </Text>
                        <Text className="text-sm font-medium text-foreground">{m.count}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>
          )}
        </View>

        {/* Footer Links */}
        <View className="px-4 pb-4 gap-2">
          <Pressable onPress={() => navigate("/(app)/settings/usage")} className="flex-row items-center gap-1 active:opacity-70">
            <Text className="text-sm font-medium text-primary">{t('credits.manageBilling')}</Text>
            <Text className="text-sm text-primary">&rsaquo;</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
