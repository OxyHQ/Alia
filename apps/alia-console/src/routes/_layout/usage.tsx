import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useGlobalUsage } from '@/hooks/use-developer';

export const Route = createFileRoute('/_layout/usage')({
  component: UsagePage,
});

const periods = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

function UsagePage() {
  const [period, setPeriod] = useState('7d');
  const { data: usage, isLoading } = useGlobalUsage(period);

  const summary = usage?.summary;
  const successRate =
    summary && summary.totalRequests > 0
      ? Math.round(((summary.successfulRequests ?? 0) / summary.totalRequests) * 100)
      : 0;

  return (
    <div className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Usage</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor your API usage and statistics
            </p>
          </div>
          <div className="flex gap-1">
            {periods.map((p) => (
              <Button
                key={p.value}
                variant={period === p.value ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Overview</p>
        {isLoading ? (
          <div className="animate-pulse flex flex-row gap-12">
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
            <div className="h-12 w-24 bg-muted rounded" />
          </div>
        ) : (
          <div className="flex flex-row gap-12">
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(summary?.totalRequests ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Total requests</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(summary?.totalTokens ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Total tokens</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(summary?.totalCredits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Credits used</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {Math.round(summary?.avgResponseTime ?? 0)}ms
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Avg response</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">{successRate}%</p>
              <p className="text-sm text-muted-foreground mt-0.5">Success rate</p>
            </div>
          </div>
        )}
      </div>

      {/* Usage by Day */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Usage by day</p>
        {isLoading ? (
          <div className="h-24 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : usage?.byDay && usage.byDay.length > 0 ? (
          <div className="space-y-2">
            {usage.byDay.map((day) => (
              <div
                key={day._id}
                className="flex items-center justify-between py-2 border-b border-border last:border-0"
              >
                <p className="text-sm text-foreground">{day._id}</p>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>{day.requests.toLocaleString()} requests</span>
                  <span>{day.tokens.toLocaleString()} tokens</span>
                  <span>{day.credits.toLocaleString()} credits</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No usage data available for this period
          </div>
        )}
      </div>

      {/* Usage by Endpoint */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-foreground mb-4">Usage by endpoint</p>
        {isLoading ? (
          <div className="h-24 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : usage?.byEndpoint && usage.byEndpoint.length > 0 ? (
          <div className="space-y-2">
            {usage.byEndpoint.map((endpoint) => (
              <div
                key={endpoint._id}
                className="flex items-center justify-between py-2 border-b border-border last:border-0"
              >
                <p className="text-sm text-foreground font-mono">{endpoint._id}</p>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>{endpoint.requests.toLocaleString()} requests</span>
                  <span>{endpoint.tokens.toLocaleString()} tokens</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No endpoint data available for this period
          </div>
        )}
      </div>
    </div>
  );
}
