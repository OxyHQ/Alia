import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { apiClient } from '@/lib/api/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  Activity,
  Coins,
  Clock,
  TrendingUp,
  Zap,
  BarChart3,
} from 'lucide-react';
import type { ChartConfig } from '@/components/ui/chart';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

const PERIODS = ['24h', '7d', '30d', '90d'] as const;
type Period = typeof PERIODS[number];

const COLORS = {
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7',
  orange: '#f97316',
  red: '#ef4444',
};

interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  avgResponseTime: number;
  successfulRequests: number;
  errorRequests: number;
}

interface UsageByDay {
  _id: string;
  requests: number;
  tokens: number;
  credits: number;
}

interface UsageByEndpoint {
  _id: string;
  requests: number;
  tokens: number;
}

interface UsageData {
  success: boolean;
  data: {
    summary: UsageSummary;
    byDay: UsageByDay[];
    byEndpoint: UsageByEndpoint[];
  };
}

interface CostStats {
  totalRevenue: number;
  totalTokens: number;
  totalRequests: number;
  uniqueUsers: number;
  costByAliasModel: Record<string, number>;
  costByActualProvider: Record<string, number>;
  avgCostPerRequest: number;
  cacheSavingsTotal: number;
  freeTierSavingsTotal: number;
}

interface CostData {
  success: boolean;
  data: CostStats;
}

export function UsagePage() {
  const { isAuthenticated } = useAuth();
  const [period, setPeriod] = useState<Period>('7d');
  const [activeTab, setActiveTab] = useState('overview');

  const { data: usageData, isLoading: usageLoading } = useQuery<UsageData>({
    queryKey: ['usage', period],
    queryFn: () => apiClient.getUsage(period) as Promise<UsageData>,
    refetchInterval: 30000,
    enabled: isAuthenticated,
  });

  const { data: costsData, isLoading: costsLoading } = useQuery<CostData>({
    queryKey: ['usage-costs', period],
    queryFn: () => apiClient.getUsageCosts(period) as Promise<CostData>,
    refetchInterval: 60000,
    enabled: isAuthenticated,
  });

  const summary = usageData?.data?.summary || {
    totalRequests: 0,
    totalTokens: 0,
    totalCredits: 0,
    avgResponseTime: 0,
    successfulRequests: 0,
    errorRequests: 0,
  };

  const successRate = summary.totalRequests > 0
    ? ((summary.successfulRequests / summary.totalRequests) * 100).toFixed(1)
    : '0.0';

  const byDayChartData = useMemo(() => {
    return (usageData?.data?.byDay || []).map((d) => ({
      date: d._id,
      requests: d.requests,
      tokens: d.tokens,
    }));
  }, [usageData]);

  const byEndpoint = usageData?.data?.byEndpoint || [];

  const costs = costsData?.data;

  const costByModelChartData = useMemo(() => {
    if (!costs?.costByAliasModel) return [];
    return Object.entries(costs.costByAliasModel)
      .map(([model, cost]) => ({ model, cost: Number(cost.toFixed(4)) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
  }, [costs]);

  const costByProviderChartData = useMemo(() => {
    if (!costs?.costByActualProvider) return [];
    return Object.entries(costs.costByActualProvider)
      .map(([provider, cost]) => ({ provider, cost: Number(cost.toFixed(4)) }))
      .sort((a, b) => b.cost - a.cost);
  }, [costs]);

  const chartConfig = {
    requests: { label: 'Requests', color: COLORS.blue },
    tokens: { label: 'Tokens', color: COLORS.purple },
    cost: { label: 'Cost ($)', color: COLORS.green },
  } satisfies ChartConfig;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Usage & Analytics</h1>
          <p className="text-muted-foreground">API usage statistics and cost breakdown</p>
        </div>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Button
              key={p}
              variant={period === p ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPeriod(p)}
            >
              {p}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.totalRequests.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {summary.successfulRequests.toLocaleString()} successful, {summary.errorRequests.toLocaleString()} errors
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.totalTokens.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {summary.totalCredits.toLocaleString()} credits used
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{Math.round(summary.avgResponseTime || 0)}ms</div>
            <p className="text-xs text-muted-foreground">Average across all endpoints</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{successRate}%</div>
            <p className="text-xs text-muted-foreground">
              Requests with status &lt; 400
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Requests by Day */}
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>Requests by Day</CardTitle>
                <CardDescription>Daily request volume over the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                {usageLoading ? (
                  <div className="text-center py-8 text-muted-foreground">Loading...</div>
                ) : byDayChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No usage data for this period</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <BarChart data={byDayChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="requests" fill={COLORS.blue} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            {/* Top Endpoints */}
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>Top Endpoints</CardTitle>
                <CardDescription>Most used API endpoints by request count</CardDescription>
              </CardHeader>
              <CardContent>
                {usageLoading ? (
                  <div className="text-center py-8 text-muted-foreground">Loading...</div>
                ) : byEndpoint.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No endpoint data available</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Endpoint</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byEndpoint.map((ep) => (
                        <TableRow key={ep._id}>
                          <TableCell className="font-mono text-sm">{ep._id}</TableCell>
                          <TableCell className="text-right">{ep.requests.toLocaleString()}</TableCell>
                          <TableCell className="text-right">{(ep.tokens || 0).toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Costs Tab */}
        <TabsContent value="costs" className="space-y-4">
          {/* Cost Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
                <Coins className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${(costs?.totalRevenue || 0).toFixed(4)}</div>
                <p className="text-xs text-muted-foreground">
                  {costs?.totalRequests.toLocaleString() || 0} requests
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Avg Cost / Request</CardTitle>
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${(costs?.avgCostPerRequest || 0).toFixed(6)}</div>
                <p className="text-xs text-muted-foreground">
                  {costs?.uniqueUsers || 0} unique users
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Cache Savings</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${(costs?.cacheSavingsTotal || 0).toFixed(4)}</div>
                <p className="text-xs text-muted-foreground">Saved from prompt caching</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Free Tier Savings</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${(costs?.freeTierSavingsTotal || 0).toFixed(4)}</div>
                <p className="text-xs text-muted-foreground">Saved from free providers</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Cost by Model */}
            <Card>
              <CardHeader>
                <CardTitle>Cost by Model</CardTitle>
                <CardDescription>Spending breakdown by OxyAI model</CardDescription>
              </CardHeader>
              <CardContent>
                {costsLoading ? (
                  <div className="text-center py-8 text-muted-foreground">Loading...</div>
                ) : costByModelChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No cost data available</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <BarChart data={costByModelChartData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis dataKey="model" type="category" width={120} tick={{ fontSize: 11 }} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="cost" fill={COLORS.green} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            {/* Cost by Provider */}
            <Card>
              <CardHeader>
                <CardTitle>Cost by Provider</CardTitle>
                <CardDescription>Spending breakdown by actual provider</CardDescription>
              </CardHeader>
              <CardContent>
                {costsLoading ? (
                  <div className="text-center py-8 text-muted-foreground">Loading...</div>
                ) : costByProviderChartData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No cost data available</div>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[300px]">
                    <BarChart data={costByProviderChartData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis dataKey="provider" type="category" width={100} tick={{ fontSize: 11 }} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="cost" fill={COLORS.purple} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
