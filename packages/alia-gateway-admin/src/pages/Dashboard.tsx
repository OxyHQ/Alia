import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import type { DashboardStats } from '@/lib/api/client';
import { useRealtimeHealth, useRealtimeKeys } from '@/lib/websocket/hooks';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Key,
  Server,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  TrendingUp,
  DollarSign,
  Activity,
  Clock,
  Coins,
  Zap,
  ShieldAlert,
  BarChart3,
} from 'lucide-react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { HealthMetrics, ProviderKey, ApiEnvelope } from '@/types';

// Chart colors palette
const CHART_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#6366f1', // indigo
];

function getLatencyColor(ms: number): string {
  if (ms < 500) return 'text-green-500';
  if (ms < 1500) return 'text-yellow-500';
  if (ms < 3000) return 'text-orange-500';
  return 'text-red-500';
}

function getLatencyBg(ms: number): string {
  if (ms < 500) return 'bg-green-500/10';
  if (ms < 1500) return 'bg-yellow-500/10';
  if (ms < 3000) return 'bg-orange-500/10';
  return 'bg-red-500/10';
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatHour(timeStr: string): string {
  try {
    const d = new Date(timeStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return timeStr;
  }
}

// Custom tooltip for charts
interface ChartTooltipEntry {
  name?: string;
  value: number;
  color?: string;
}

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string | number;
  formatter?: (value: number) => string;
}

function ChartTooltipContent({ active, payload, label, formatter }: ChartTooltipContentProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-background px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload.map((entry: ChartTooltipEntry, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-medium text-foreground">
            {formatter ? formatter(entry.value) : entry.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { isAuthenticated } = useAuth();
  const [costPeriod, setCostPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');

  // Real-time data subscriptions
  const { data: realtimeHealthData, isConnected: healthConnected } = useRealtimeHealth();
  const { data: realtimeKeysData, isConnected: keysConnected } = useRealtimeKeys();

  // Fallback to polling if WebSocket is not connected
  const { data: polledHealthData, isLoading: healthLoading } = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => apiClient.getAllProviderHealth(),
    refetchInterval: healthConnected ? false : 30000,
    enabled: isAuthenticated && !healthConnected,
  });

  const { data: polledKeysData, isLoading: keysLoading } = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiClient.listKeys(),
    refetchInterval: keysConnected ? false : 60000,
    enabled: isAuthenticated && !keysConnected,
  });

  // Dashboard stats (aggregated endpoint)
  const { data: dashboardData, isLoading: dashboardLoading } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => apiClient.getDashboardStats(),
    refetchInterval: 60000,
    enabled: isAuthenticated,
  });

  // Use real-time data if available, otherwise fall back to polled data
  const healthData = realtimeHealthData || polledHealthData;
  const keysData = realtimeKeysData || polledKeysData;

  const health: HealthMetrics[] = (healthData as ApiEnvelope<HealthMetrics[]>)?.data || [];
  const keys: ProviderKey[] = (keysData as ApiEnvelope<ProviderKey[]>)?.data || [];
  const stats: DashboardStats | undefined = (dashboardData as ApiEnvelope<DashboardStats>)?.data;

  // Calculate stats
  const totalKeys = keys.length;
  const activeKeys = keys.filter(k => k.isActive && !k.isArchived).length;
  const archivedKeys = keys.filter(k => k.isArchived).length;
  const failingKeys = keys.filter(k => k.consecutiveFailures > 3).length;

  const healthyProviders = health.filter(h => h.isHealthy).length;
  const totalProviders = health.length;
  const avgSuccessRate = health.length > 0
    ? health.reduce((sum, h) => sum + h.successRate, 0) / health.length
    : 0;

  const totalAlerts = (stats?.alerts.failingKeys.length || 0)
    + (stats?.alerts.openCircuitBreakers.length || 0)
    + (stats?.alerts.nearCreditLimitKeys.length || 0);

  // Cost period data
  const costData = stats?.costsByProvider[costPeriod] || [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Overview of your providers, keys, and system health
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Keys</CardTitle>
            <Key className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalKeys}</div>
            <p className="text-xs text-muted-foreground">
              {activeKeys} active, {archivedKeys} archived
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Providers</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {healthyProviders}/{totalProviders}
            </div>
            <p className="text-xs text-muted-foreground">
              {((healthyProviders / (totalProviders || 1)) * 100).toFixed(0)}% healthy
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgSuccessRate.toFixed(1)}%</div>
            <Progress value={avgSuccessRate} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Alerts</CardTitle>
            {totalAlerts > 0 ? (
              <AlertTriangle className="h-4 w-4 text-orange-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalAlerts}</div>
            <p className="text-xs text-muted-foreground">
              {failingKeys} failing keys, {stats?.alerts.openCircuitBreakers.length || 0} open circuits
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Active Alerts Section */}
      {totalAlerts > 0 && (
        <Card className="border-orange-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-orange-500" />
              Active Alerts
            </CardTitle>
            <CardDescription>
              Issues requiring attention
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Failing Keys */}
            {stats?.alerts.failingKeys.map((key) => (
              <Alert key={key.id} variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertDescription className="flex items-center justify-between">
                  <span>
                    Key <span className="font-semibold">{key.name}</span> ({key.provider})
                    has {key.consecutiveFailures} consecutive failures
                  </span>
                  <Badge variant="destructive" className="ml-2">
                    {key.consecutiveFailures} failures
                  </Badge>
                </AlertDescription>
              </Alert>
            ))}

            {/* Open Circuit Breakers */}
            {stats?.alerts.openCircuitBreakers.map((cb) => (
              <Alert key={`${cb.provider}-${cb.modelId}`} variant="destructive">
                <Zap className="h-4 w-4" />
                <AlertDescription className="flex items-center justify-between">
                  <span>
                    Circuit breaker <span className="font-semibold">OPEN</span> for{' '}
                    {cb.provider}/{cb.modelId} ({cb.successRate.toFixed(1)}% success rate)
                  </span>
                  <Badge variant="destructive" className="ml-2">
                    Circuit Open
                  </Badge>
                </AlertDescription>
              </Alert>
            ))}

            {/* Near Credit Limit Keys */}
            {stats?.alerts.nearCreditLimitKeys.map((key) => (
              <Alert key={key.id}>
                <DollarSign className="h-4 w-4" />
                <AlertDescription className="flex items-center justify-between">
                  <span>
                    Key <span className="font-semibold">{key.name}</span> ({key.provider})
                    at {key.percentUsed}% of credit limit (${key.spentUSD.toFixed(2)} / ${key.creditLimitUSD.toFixed(2)})
                  </span>
                  <Badge
                    variant={key.percentUsed >= 95 ? 'destructive' : 'secondary'}
                    className="ml-2"
                  >
                    {key.percentUsed}% used
                  </Badge>
                </AlertDescription>
              </Alert>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Charts Row: Requests Timeline + Top Models */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Requests Chart (24h) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Requests (24h)
            </CardTitle>
            <CardDescription>
              Request volume over the last 24 hours
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboardLoading ? (
              <Skeleton className="h-[250px] w-full" />
            ) : !stats?.requestsTimeline.length ? (
              <div className="flex h-[250px] items-center justify-center text-muted-foreground">
                No request data available
              </div>
            ) : (
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={stats.requestsTimeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="time"
                      tickFormatter={formatHour}
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      stroke="var(--border)"
                    />
                    <YAxis
                      tickFormatter={formatNumber}
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      stroke="var(--border)"
                    />
                    <Tooltip
                      content={
                        <ChartTooltipContent
                          formatter={(v: number) => formatNumber(v)}
                        />
                      }
                    />
                    <Line
                      type="monotone"
                      dataKey="requests"
                      name="Requests"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#3b82f6' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="tokens"
                      name="Tokens"
                      stroke="#8b5cf6"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#8b5cf6' }}
                      yAxisId={0}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Models Bar Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Top Models (7d)
            </CardTitle>
            <CardDescription>
              Most used models by request count
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboardLoading ? (
              <Skeleton className="h-[250px] w-full" />
            ) : !stats?.topModels.length ? (
              <div className="flex h-[250px] items-center justify-center text-muted-foreground">
                No model data available
              </div>
            ) : (
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={stats.topModels.slice(0, 5)}
                    layout="vertical"
                    margin={{ left: 10, right: 20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={formatNumber}
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      stroke="var(--border)"
                    />
                    <YAxis
                      type="category"
                      dataKey="modelId"
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      stroke="var(--border)"
                      width={120}
                    />
                    <Tooltip
                      content={
                        <ChartTooltipContent
                          formatter={(v: number) => formatNumber(v)}
                        />
                      }
                    />
                    <Bar dataKey="requests" name="Requests" radius={[0, 4, 4, 0]}>
                      {stats.topModels.slice(0, 5).map((_, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={CHART_COLORS[index % CHART_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Second Row: Costs Overview + Average Latency */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Costs Overview */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Usage by Provider
                </CardTitle>
                <CardDescription>
                  Request and token usage breakdown
                </CardDescription>
              </div>
              <Tabs value={costPeriod} onValueChange={(v) => setCostPeriod(v as 'daily' | 'weekly' | 'monthly')}>
                <TabsList>
                  <TabsTrigger value="daily">24h</TabsTrigger>
                  <TabsTrigger value="weekly">7d</TabsTrigger>
                  <TabsTrigger value="monthly">30d</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {dashboardLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !costData.length ? (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground">
                No usage data for this period
              </div>
            ) : (
              <div className="space-y-3">
                {costData.map((item, index) => {
                  const maxRequests = Math.max(...costData.map(c => c.requests));
                  const pct = maxRequests > 0 ? (item.requests / maxRequests) * 100 : 0;
                  return (
                    <div key={item.provider} className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-3 w-3 rounded-sm"
                            style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                          />
                          <span className="font-medium capitalize">{item.provider}</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>{formatNumber(item.requests)} req</span>
                          <span>{formatNumber(item.tokens)} tok</span>
                        </div>
                      </div>
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* Key Spend Summary */}
                {stats?.spendByProvider && stats.spendByProvider.some(s => s.spentUSD > 0) && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Key Spend</p>
                    <div className="grid grid-cols-2 gap-2">
                      {stats.spendByProvider
                        .filter(s => s.spentUSD > 0)
                        .sort((a, b) => b.spentUSD - a.spentUSD)
                        .slice(0, 6)
                        .map(s => (
                          <div key={s.provider} className="flex items-center justify-between text-xs">
                            <span className="capitalize text-muted-foreground">{s.provider}</span>
                            <span className="font-medium">${s.spentUSD.toFixed(2)}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Average Latency Per Provider */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Average Latency
            </CardTitle>
            <CardDescription>
              Per-provider response time indicator
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboardLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !stats?.avgLatencyPerProvider.length ? (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground">
                No latency data available
              </div>
            ) : (
              <div className="space-y-2">
                {stats.avgLatencyPerProvider.map((item) => {
                  const maxLatency = Math.max(...stats.avgLatencyPerProvider.map(l => l.averageLatencyMs));
                  const pct = maxLatency > 0 ? (item.averageLatencyMs / maxLatency) * 100 : 0;
                  return (
                    <div
                      key={item.provider}
                      className={`flex items-center justify-between p-2.5 rounded-lg border ${getLatencyBg(item.averageLatencyMs)}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium capitalize">{item.provider}</span>
                          <span className="text-xs text-muted-foreground">
                            {item.modelCount} model{item.modelCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${pct}%`,
                              backgroundColor:
                                item.averageLatencyMs < 500 ? '#10b981'
                                : item.averageLatencyMs < 1500 ? '#f59e0b'
                                : item.averageLatencyMs < 3000 ? '#f97316'
                                : '#ef4444',
                            }}
                          />
                        </div>
                        <span className={`text-sm font-mono font-bold tabular-nums min-w-[4.5rem] text-right ${getLatencyColor(item.averageLatencyMs)}`}>
                          {item.averageLatencyMs.toLocaleString()}ms
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Credits Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Credits Overview
          </CardTitle>
          <CardDescription>
            Total credits used vs available across all users
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dashboardLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Total Users</p>
                <p className="mt-1 text-2xl font-bold">
                  {formatNumber(stats?.creditsOverview.totalUsers || 0)}
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Available Balance</p>
                <p className="mt-1 text-2xl font-bold text-green-500">
                  {formatNumber(stats?.creditsOverview.totalBalance || 0)}
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Total Earned</p>
                <p className="mt-1 text-2xl font-bold text-blue-500">
                  {formatNumber(stats?.creditsOverview.totalEarned || 0)}
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">Total Spent</p>
                <p className="mt-1 text-2xl font-bold text-orange-500">
                  {formatNumber(stats?.creditsOverview.totalSpent || 0)}
                </p>
              </div>
            </div>
          )}

          {/* Usage ratio bar */}
          {stats?.creditsOverview && stats.creditsOverview.totalEarned > 0 && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Credits Utilization</span>
                <span>
                  {((stats.creditsOverview.totalSpent / stats.creditsOverview.totalEarned) * 100).toFixed(1)}%
                  consumed
                </span>
              </div>
              <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-orange-500 transition-all duration-500"
                  style={{
                    width: `${Math.min(
                      100,
                      (stats.creditsOverview.totalSpent / stats.creditsOverview.totalEarned) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Provider Health */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Health Status</CardTitle>
          <CardDescription>
            Real-time health monitoring of all providers
          </CardDescription>
        </CardHeader>
        <CardContent>
          {healthLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : health.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No provider health data available
            </div>
          ) : (
            <div className="space-y-4">
              {health.slice(0, 10).map((h) => (
                <div
                  key={`${h.provider}-${h.modelId}`}
                  className="flex items-center justify-between p-4 rounded-lg border"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      {h.isHealthy ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                      <div>
                        <p className="font-medium">{h.provider}/{h.modelId}</p>
                        <p className="text-sm text-muted-foreground">
                          {h.totalRequests} requests
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-sm font-medium">{h.successRate.toFixed(1)}%</p>
                      <p className="text-xs text-muted-foreground">Success Rate</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-medium ${getLatencyColor(h.averageLatencyMs)}`}>
                        {h.averageLatencyMs}ms
                      </p>
                      <p className="text-xs text-muted-foreground">Avg Latency</p>
                    </div>
                    <Badge
                      variant={
                        h.circuitState === 'closed'
                          ? 'default'
                          : h.circuitState === 'open'
                          ? 'destructive'
                          : 'secondary'
                      }
                    >
                      {h.circuitState}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Keys Activity */}
      <Card>
        <CardHeader>
          <CardTitle>API Keys Overview</CardTitle>
          <CardDescription>
            Recent activity and status of your API keys
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keysLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No API keys configured. Add keys in the Keys page.
            </div>
          ) : (
            <div className="space-y-3">
              {keys.slice(0, 10).map((key) => (
                <div
                  key={key._id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        key.isArchived
                          ? 'bg-gray-500'
                          : key.isActive
                          ? 'bg-green-500'
                          : 'bg-yellow-500'
                      }`}
                    />
                    <div>
                      <p className="font-medium text-sm">{key.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {key.provider} -- {key.keyPrefix}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-sm font-medium">{key.totalRequests}</p>
                      <p className="text-xs text-muted-foreground">Requests</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">
                        {key.successCount}/{key.totalFailures}
                      </p>
                      <p className="text-xs text-muted-foreground">Success/Fail</p>
                    </div>
                    <div className="flex gap-1">
                      {key.isArchived && (
                        <Badge variant="secondary">Archived</Badge>
                      )}
                      {!key.isArchived && !key.isPaid && (
                        <Badge variant="outline">Free</Badge>
                      )}
                      {!key.isArchived && key.isPaid && (
                        <Badge>Paid</Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
