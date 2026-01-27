import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { useRealtimeHealth, useRealtimeKeys } from '@/lib/websocket/hooks';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Key,
  Server,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  TrendingUp
} from 'lucide-react';
import type { HealthMetrics, ProviderKey } from '@/types';

export function DashboardPage() {
  // Real-time data subscriptions
  const { data: realtimeHealthData, isConnected: healthConnected } = useRealtimeHealth();
  const { data: realtimeKeysData, isConnected: keysConnected } = useRealtimeKeys();

  // Fallback to polling if WebSocket is not connected
  const { data: polledHealthData, isLoading: healthLoading } = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => apiClient.getAllProviderHealth(),
    refetchInterval: healthConnected ? false : 30000,
    enabled: !healthConnected, // Only poll if WebSocket is not connected
  });

  const { data: polledKeysData, isLoading: keysLoading } = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiClient.listKeys(),
    refetchInterval: keysConnected ? false : 60000,
    enabled: !keysConnected, // Only poll if WebSocket is not connected
  });

  // Use real-time data if available, otherwise fall back to polled data
  const healthData = realtimeHealthData || polledHealthData;
  const keysData = realtimeKeysData || polledKeysData;

  const health: HealthMetrics[] = (healthData as any)?.data || [];
  const keys: ProviderKey[] = (keysData as any)?.data || [];

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
            <CardTitle className="text-sm font-medium">Failing Keys</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{failingKeys}</div>
            <p className="text-xs text-muted-foreground">
              Keys with 3+ consecutive failures
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Alerts */}
      {archivedKeys > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {archivedKeys} key{archivedKeys > 1 ? 's have' : ' has'} been archived due to excessive failures.
            Review and replace them in the Keys page.
          </AlertDescription>
        </Alert>
      )}

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
                      <p className="text-sm font-medium">{h.averageLatencyMs}ms</p>
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
                        {key.provider} • {key.keyPrefix}
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
