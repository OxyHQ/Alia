import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

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

  // TODO: Replace with real data from hooks
  const stats = {
    totalRequests: 0,
    totalTokens: 0,
    totalCredits: 0,
    avgResponseTime: 0,
    successRate: 0,
  };

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
        <div className="flex flex-row gap-12">
          <div>
            <p className="text-2xl font-semibold text-foreground">
              {stats.totalRequests.toLocaleString()}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">Total requests</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-foreground">
              {stats.totalTokens.toLocaleString()}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">Total tokens</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-foreground">
              {stats.totalCredits.toLocaleString()}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">Credits used</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-foreground">{stats.avgResponseTime}ms</p>
            <p className="text-sm text-muted-foreground mt-0.5">Avg response</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-foreground">{stats.successRate}%</p>
            <p className="text-sm text-muted-foreground mt-0.5">Success rate</p>
          </div>
        </div>
      </div>

      {/* Usage Chart Placeholder */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Usage over time</p>
        <div className="h-48 flex items-center justify-center text-muted-foreground border border-dashed border-border rounded-lg">
          {/* TODO: Add chart component */}
          <p className="text-sm">Usage chart will be displayed here</p>
        </div>
      </div>

      {/* Usage by Endpoint */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-foreground mb-4">Usage by endpoint</p>
        <div className="py-8 text-center text-sm text-muted-foreground">
          No usage data available for this period
        </div>
      </div>
    </div>
  );
}
