import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { useRealtimeHealth, useRealtimeKeys } from '@/lib/websocket/hooks';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  Activity,
  TrendingUp,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Zap,
} from 'lucide-react';
import type { HealthMetrics, ProviderKey } from '@/types';
import type {
  ChartConfig,
} from '@/components/ui/chart';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { Bar, BarChart, Line, LineChart, Pie, PieChart, CartesianGrid, XAxis, YAxis, Cell } from 'recharts';

const COLORS = {
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#eab308',
  blue: '#3b82f6',
  purple: '#a855f7',
};

export function MonitoringPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [filterProvider, setFilterProvider] = useState<string>('all');

  // Real-time data subscriptions
  const { data: realtimeHealthData, isConnected: healthConnected } = useRealtimeHealth();
  const { data: realtimeKeysData, isConnected: keysConnected } = useRealtimeKeys();

  // Fallback to polling if WebSocket is not connected
  const { data: polledHealthData, isLoading: healthLoading } = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => apiClient.getAllProviderHealth(),
    refetchInterval: healthConnected ? false : 10000,
    enabled: !healthConnected, // Only poll if WebSocket is not connected
  });

  const { data: polledKeysData, isLoading: keysLoading } = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiClient.listKeys(),
    refetchInterval: keysConnected ? false : 10000,
    enabled: !keysConnected, // Only poll if WebSocket is not connected
  });

  // Use real-time data if available, otherwise fall back to polled data
  const healthData = realtimeHealthData || polledHealthData;
  const keysData = realtimeKeysData || polledKeysData;

  const health: HealthMetrics[] = (healthData as any)?.data || [];
  const keys: ProviderKey[] = (keysData as any)?.data || [];

  // Get unique providers
  const providers = useMemo(() => {
    const providerSet = new Set(health.map((h) => h.provider));
    return Array.from(providerSet).sort();
  }, [health]);

  // Filter health data by provider
  const filteredHealth = useMemo(() => {
    if (filterProvider === 'all') return health;
    return health.filter((h) => h.provider === filterProvider);
  }, [health, filterProvider]);

  // Calculate overall stats
  const stats = useMemo(() => {
    const totalRequests = health.reduce((sum, h) => sum + h.totalRequests, 0);
    const successfulRequests = health.reduce(
      (sum, h) => sum + Math.floor((h.successRate / 100) * h.totalRequests),
      0
    );
    const failedRequests = totalRequests - successfulRequests;
    const avgSuccessRate =
      health.length > 0 ? health.reduce((sum, h) => sum + h.successRate, 0) / health.length : 0;
    const avgLatency =
      health.length > 0
        ? health.reduce((sum, h) => sum + h.averageLatencyMs, 0) / health.length
        : 0;
    const healthyProviders = health.filter((h) => h.isHealthy).length;
    const openCircuits = health.filter((h) => h.circuitState === 'open').length;

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      avgSuccessRate,
      avgLatency,
      healthyProviders,
      totalProviders: health.length,
      openCircuits,
    };
  }, [health]);

  // Prepare chart data
  const successRateChartData = useMemo(() => {
    return filteredHealth
      .slice(0, 15)
      .map((h) => ({
        name: `${h.provider}/${h.modelId}`,
        successRate: h.successRate,
        failureRate: 100 - h.successRate,
      }))
      .reverse();
  }, [filteredHealth]);

  const latencyChartData = useMemo(() => {
    return filteredHealth
      .slice(0, 15)
      .map((h) => ({
        name: `${h.provider}/${h.modelId}`,
        latency: h.averageLatencyMs,
      }))
      .reverse();
  }, [filteredHealth]);

  const circuitStateChartData = useMemo(() => {
    const stateCount = health.reduce(
      (acc, h) => {
        acc[h.circuitState] = (acc[h.circuitState] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return [
      { name: 'Closed', value: stateCount.closed || 0, color: COLORS.green },
      { name: 'Half-Open', value: stateCount['half-open'] || 0, color: COLORS.yellow },
      { name: 'Open', value: stateCount.open || 0, color: COLORS.red },
    ].filter((d) => d.value > 0);
  }, [health]);

  const requestsChartData = useMemo(() => {
    return filteredHealth
      .slice(0, 10)
      .map((h) => ({
        name: `${h.provider}/${h.modelId}`,
        requests: h.totalRequests,
      }))
      .sort((a, b) => b.requests - a.requests);
  }, [filteredHealth]);

  // Key priority rotation data
  const keysByProvider = useMemo(() => {
    const grouped = keys.reduce(
      (acc, key) => {
        if (!acc[key.provider]) acc[key.provider] = [];
        acc[key.provider].push(key);
        return acc;
      },
      {} as Record<string, ProviderKey[]>
    );

    // Sort each provider's keys by currentPriority
    Object.keys(grouped).forEach((provider) => {
      grouped[provider].sort((a, b) => a.currentPriority - b.currentPriority);
    });

    return grouped;
  }, [keys]);

  const chartConfig = {
    successRate: {
      label: 'Success Rate',
      color: COLORS.green,
    },
    failureRate: {
      label: 'Failure Rate',
      color: COLORS.red,
    },
    latency: {
      label: 'Latency (ms)',
      color: COLORS.blue,
    },
    requests: {
      label: 'Requests',
      color: COLORS.purple,
    },
  } satisfies ChartConfig;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Monitoring</h1>
        <p className="text-muted-foreground">Real-time provider health and key rotation monitoring</p>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalRequests.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {stats.successfulRequests.toLocaleString()} successful,{' '}
              {stats.failedRequests.toLocaleString()} failed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgSuccessRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">
              {stats.healthyProviders}/{stats.totalProviders} providers healthy
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{Math.round(stats.avgLatency)}ms</div>
            <p className="text-xs text-muted-foreground">Average response time</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Circuit Breakers</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.openCircuits}</div>
            <p className="text-xs text-muted-foreground">Open circuits (failing providers)</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-4 items-end">
        <div className="grid gap-2">
          <Label>Filter by Provider</Label>
          <Select value={filterProvider} onValueChange={setFilterProvider}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="key-rotation">Key Rotation</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Success Rate Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Success Rate by Model</CardTitle>
                <CardDescription>Success vs failure rate for each provider model</CardDescription>
              </CardHeader>
              <CardContent>
                {successRateChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No data available</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <BarChart data={successRateChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="name"
                        angle={-45}
                        textAnchor="end"
                        height={100}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="successRate" fill={COLORS.green} stackId="a" />
                      <Bar dataKey="failureRate" fill={COLORS.red} stackId="a" />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            {/* Circuit State Distribution */}
            <Card>
              <CardHeader>
                <CardTitle>Circuit Breaker States</CardTitle>
                <CardDescription>Distribution of circuit breaker states</CardDescription>
              </CardHeader>
              <CardContent>
                {circuitStateChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No data available</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <PieChart>
                      <Pie
                        data={circuitStateChartData}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={({ name, value }) => `${name}: ${value}`}
                        outerRadius={100}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {circuitStateChartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <ChartTooltip content={<ChartTooltipContent />} />
                    </PieChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Performance Tab */}
        <TabsContent value="performance" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Latency Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Average Latency</CardTitle>
                <CardDescription>Response time in milliseconds</CardDescription>
              </CardHeader>
              <CardContent>
                {latencyChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No data available</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <LineChart data={latencyChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="name"
                        angle={-45}
                        textAnchor="end"
                        height={100}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Line
                        type="monotone"
                        dataKey="latency"
                        stroke={COLORS.blue}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            {/* Request Volume Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Request Volume</CardTitle>
                <CardDescription>Top models by request count</CardDescription>
              </CardHeader>
              <CardContent>
                {requestsChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No data available</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <BarChart data={requestsChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="name"
                        angle={-45}
                        textAnchor="end"
                        height={100}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="requests" fill={COLORS.purple} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Key Rotation Tab */}
        <TabsContent value="key-rotation" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Priority Rotation Status</CardTitle>
              <CardDescription>
                Keys are automatically rotated based on success/failure. Free keys are always tried
                first.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {keysLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : Object.keys(keysByProvider).length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No keys configured</div>
              ) : (
                Object.entries(keysByProvider).map(([provider, providerKeys]) => {
                  const freeKeys = providerKeys.filter((k) => !k.isPaid && !k.isArchived);
                  const paidKeys = providerKeys.filter((k) => k.isPaid && !k.isArchived);

                  return (
                    <div key={provider} className="space-y-3">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-lg">
                          {provider.charAt(0).toUpperCase() + provider.slice(1)}
                        </h3>
                        <Badge variant="outline">
                          {freeKeys.length} free, {paidKeys.length} paid
                        </Badge>
                      </div>

                      {/* Free Keys */}
                      {freeKeys.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground font-medium">Free Tier</p>
                          <div className="space-y-2">
                            {freeKeys.map((key, index) => {
                              const isDemoted = key.currentPriority !== key.originalPriority;
                              return (
                                <div
                                  key={key._id}
                                  className="flex items-center gap-3 p-3 rounded-lg border bg-card"
                                >
                                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted text-sm font-medium">
                                    {index + 1}
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium">{key.name}</span>
                                      <code className="text-xs">{key.keyPrefix}</code>
                                      {isDemoted && (
                                        <Badge variant="secondary" className="text-xs">
                                          Deprioritized
                                        </Badge>
                                      )}
                                      {!key.isActive && (
                                        <Badge variant="outline" className="text-xs">
                                          Inactive
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                                      <span>Priority: {key.currentPriority}</span>
                                      {isDemoted && (
                                        <span className="text-yellow-600">
                                          (Original: {key.originalPriority})
                                        </span>
                                      )}
                                      <span>
                                        Success: {key.successCount}/{key.totalRequests}
                                      </span>
                                      <span>Failures: {key.consecutiveFailures}</span>
                                    </div>
                                  </div>
                                  {key.isActive ? (
                                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                                  ) : (
                                    <XCircle className="h-5 w-5 text-red-500" />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Paid Keys */}
                      {paidKeys.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground font-medium">Paid Tier</p>
                          <div className="space-y-2">
                            {paidKeys.map((key, index) => {
                              const isDemoted = key.currentPriority !== key.originalPriority;
                              return (
                                <div
                                  key={key._id}
                                  className="flex items-center gap-3 p-3 rounded-lg border bg-card"
                                >
                                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-medium">
                                    {index + 1}
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium">{key.name}</span>
                                      <code className="text-xs">{key.keyPrefix}</code>
                                      {isDemoted && (
                                        <Badge variant="secondary" className="text-xs">
                                          Deprioritized
                                        </Badge>
                                      )}
                                      {!key.isActive && (
                                        <Badge variant="outline" className="text-xs">
                                          Inactive
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                                      <span>Priority: {key.currentPriority}</span>
                                      {isDemoted && (
                                        <span className="text-yellow-600">
                                          (Original: {key.originalPriority})
                                        </span>
                                      )}
                                      <span>
                                        Success: {key.successCount}/{key.totalRequests}
                                      </span>
                                      <span>Failures: {key.consecutiveFailures}</span>
                                    </div>
                                  </div>
                                  {key.isActive ? (
                                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                                  ) : (
                                    <XCircle className="h-5 w-5 text-red-500" />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Details Tab */}
        <TabsContent value="details" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Provider Health Details</CardTitle>
              <CardDescription>Detailed metrics for all provider models</CardDescription>
            </CardHeader>
            <CardContent>
              {healthLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : filteredHealth.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No health data available
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Requests</TableHead>
                      <TableHead>Success Rate</TableHead>
                      <TableHead>Avg Latency</TableHead>
                      <TableHead>Circuit State</TableHead>
                      <TableHead>Last Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHealth.map((h) => (
                      <TableRow key={`${h.provider}-${h.modelId}`}>
                        <TableCell>
                          {h.isHealthy ? (
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                          ) : (
                            <XCircle className="h-5 w-5 text-red-500" />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{h.provider}</TableCell>
                        <TableCell>
                          <code className="text-xs">{h.modelId}</code>
                        </TableCell>
                        <TableCell>{h.totalRequests.toLocaleString()}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span
                              className={
                                h.successRate >= 90
                                  ? 'text-green-500'
                                  : h.successRate >= 70
                                  ? 'text-yellow-500'
                                  : 'text-red-500'
                              }
                            >
                              {h.successRate.toFixed(1)}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{h.averageLatencyMs}ms</TableCell>
                        <TableCell>
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
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {new Date(h.lastRequestAt).toLocaleTimeString()}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
