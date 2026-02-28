import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import { apiClient } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  XCircle,
  CheckCircle2,
  Zap,
  GitBranch,
} from 'lucide-react';

// --- Types ---

interface LogAttempt {
  provider: string;
  model: string;
  error: string;
  reason: string;
  latencyMs: number;
}

interface LogEntry {
  _id: string;
  timestamp: string;
  aliasModel: string;
  finalProvider: string | null;
  finalModel: string | null;
  success: boolean;
  totalLatencyMs: number;
  attemptCount: number;
  hadFallback: boolean;
  attempts: LogAttempt[];
  failureReasons: string[];
}

interface LogStats {
  totalRequests: number;
  errorRate: number;
  fallbackRate: number;
  avgLatencyMs: number;
}

// --- Time Range Options ---

const TIME_RANGES = [
  { label: 'Last 1h', value: '1' },
  { label: 'Last 6h', value: '6' },
  { label: 'Last 24h', value: '24' },
  { label: 'Last 7d', value: '168' },
];

// --- Fallback Reason Labels ---

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  rate_limit: { label: 'Rate Limited', color: 'text-yellow-500' },
  timeout: { label: 'Timeout', color: 'text-orange-500' },
  auth: { label: 'Auth Error', color: 'text-red-500' },
  server_error: { label: 'Server Error', color: 'text-red-500' },
  model_not_found: { label: 'Model Not Found', color: 'text-purple-500' },
  content_filter: { label: 'Content Filter', color: 'text-yellow-600' },
  overloaded: { label: 'Overloaded', color: 'text-orange-600' },
  invalid_request: { label: 'Invalid Request', color: 'text-red-400' },
};

function getReasonDisplay(reason: string) {
  const known = REASON_LABELS[reason];
  if (known) return known;
  return { label: reason || 'Unknown', color: 'text-muted-foreground' };
}

// --- Component ---

export function LogsPage() {
  const { isAuthenticated } = useAuth();

  // Filter state
  const [filterProvider, setFilterProvider] = useState<string>('all');
  const [filterModel, setFilterModel] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterHours, setFilterHours] = useState<string>('24');
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const hours = parseInt(filterHours);

  // Fetch stats
  const { data: statsData } = useQuery({
    queryKey: ['log-stats', hours],
    queryFn: () => apiClient.getLogStats(hours),
    enabled: isAuthenticated,
    refetchInterval: 30000,
  });

  // Fetch available providers for filter dropdown
  const { data: providersData } = useQuery({
    queryKey: ['log-providers'],
    queryFn: () => apiClient.getLogProviders(),
    enabled: isAuthenticated,
  });

  // Fetch logs
  const {
    data: logsData,
    isLoading: logsLoading,
    refetch: refetchLogs,
  } = useQuery({
    queryKey: ['logs', filterProvider, filterModel, filterStatus, hours, page],
    queryFn: () =>
      apiClient.getLogs({
        provider: filterProvider,
        model: filterModel || undefined,
        status: filterStatus,
        hours,
        page,
        limit: 50,
      }),
    enabled: isAuthenticated,
    refetchInterval: 15000,
  });

  const stats: LogStats = (statsData as any)?.data || {
    totalRequests: 0,
    errorRate: 0,
    fallbackRate: 0,
    avgLatencyMs: 0,
  };

  const providers: string[] = (providersData as any)?.data || [];
  const logs: LogEntry[] = (logsData as any)?.data?.items || [];
  const pagination = (logsData as any)?.data?.pagination || {
    page: 1,
    limit: 50,
    totalCount: 0,
    totalPages: 1,
  };

  // Reset page when filters change
  const handleFilterChange = (setter: (v: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Logs</h1>
          <p className="text-muted-foreground">
            Request logs, fallback chains, and debugging information
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetchLogs()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Stats Summary */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalRequests.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              In the last {hours >= 168 ? '7 days' : hours >= 24 ? '24 hours' : `${hours}h`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Error Rate</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.errorRate > 5 ? 'text-red-500' : stats.errorRate > 1 ? 'text-yellow-500' : 'text-green-500'}`}>
              {stats.errorRate}%
            </div>
            <p className="text-xs text-muted-foreground">Requests that failed completely</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Fallback Rate</CardTitle>
            <GitBranch className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.fallbackRate > 20 ? 'text-yellow-500' : 'text-muted-foreground'}`}>
              {stats.fallbackRate}%
            </div>
            <p className="text-xs text-muted-foreground">Requests that needed fallback</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgLatencyMs.toLocaleString()}ms</div>
            <p className="text-xs text-muted-foreground">Average response time</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="grid gap-2">
              <Label>Provider</Label>
              <Select value={filterProvider} onValueChange={handleFilterChange(setFilterProvider)}>
                <SelectTrigger className="w-[180px]">
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

            <div className="grid gap-2">
              <Label>Model</Label>
              <Input
                placeholder="Search model..."
                value={filterModel}
                onChange={(e) => {
                  setFilterModel(e.target.value);
                  setPage(1);
                }}
                className="w-[200px]"
              />
            </div>

            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={filterStatus} onValueChange={handleFilterChange(setFilterStatus)}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label>Time Range</Label>
              <Select value={filterHours} onValueChange={handleFilterChange(setFilterHours)}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_RANGES.map((range) => (
                    <SelectItem key={range.value} value={range.value}>
                      {range.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Request Log Table */}
      <Card>
        <CardHeader>
          <CardTitle>Request Log</CardTitle>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="text-center py-12 text-muted-foreground">
              <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
              Loading logs...
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No logs found for the selected filters
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30px]" />
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Attempts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((entry) => (
                    <LogRow
                      key={entry._id}
                      entry={entry}
                      isExpanded={expandedRow === entry._id}
                      onToggle={() =>
                        setExpandedRow(expandedRow === entry._id ? null : entry._id)
                      }
                    />
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="flex items-center justify-between pt-4">
                <p className="text-sm text-muted-foreground">
                  Showing {(pagination.page - 1) * pagination.limit + 1}
                  {' '}-{' '}
                  {Math.min(pagination.page * pagination.limit, pagination.totalCount)} of{' '}
                  {pagination.totalCount.toLocaleString()} results
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground px-2">
                    Page {pagination.page} of {pagination.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= pagination.totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Log Row Component ---

function LogRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const ts = new Date(entry.timestamp);
  const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        <TableCell>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
          />
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1 text-sm">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span>{timeStr}</span>
            <span className="text-muted-foreground text-xs">{dateStr}</span>
          </div>
        </TableCell>
        <TableCell>
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{entry.aliasModel}</code>
        </TableCell>
        <TableCell>
          {entry.finalProvider ? (
            <span className="text-sm">{entry.finalProvider}</span>
          ) : (
            <span className="text-sm text-muted-foreground">--</span>
          )}
        </TableCell>
        <TableCell>
          {entry.success ? (
            <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
              Success
            </Badge>
          ) : (
            <Badge variant="destructive">Error</Badge>
          )}
          {entry.hadFallback && (
            <Badge className="ml-1 bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
              Fallback
            </Badge>
          )}
        </TableCell>
        <TableCell>
          <span className={`text-sm font-mono ${entry.totalLatencyMs > 5000 ? 'text-red-500' : entry.totalLatencyMs > 2000 ? 'text-yellow-500' : ''}`}>
            {entry.totalLatencyMs?.toLocaleString() ?? '--'}ms
          </span>
        </TableCell>
        <TableCell>
          <span className="text-sm">{entry.attemptCount}</span>
        </TableCell>
      </TableRow>

      {/* Expanded Details */}
      {isExpanded && (
        <TableRow>
          <TableCell colSpan={7} className="p-0">
            <div className="bg-muted/30 border-t border-b p-4 space-y-4">
              {/* Fallback Chain Visualization */}
              {entry.attempts.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-3">
                    {entry.hadFallback ? 'Fallback Chain' : 'Request Details'}
                  </h4>
                  <FallbackChain attempts={entry.attempts} success={entry.success} />
                </div>
              )}

              {/* Error Details */}
              {entry.failureReasons.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Failure Reasons</h4>
                  <div className="flex flex-wrap gap-2">
                    {entry.failureReasons.map((reason, i) => {
                      const display = getReasonDisplay(reason);
                      return (
                        <Badge key={i} variant="outline" className={display.color}>
                          {display.label}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Request Metadata */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Alias Model</span>
                  <p className="font-mono text-xs mt-0.5">{entry.aliasModel}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Final Provider</span>
                  <p className="mt-0.5">{entry.finalProvider || '--'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Final Model</span>
                  <p className="font-mono text-xs mt-0.5">{entry.finalModel || '--'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Total Latency</span>
                  <p className="mt-0.5">{entry.totalLatencyMs?.toLocaleString() ?? '--'}ms</p>
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// --- Fallback Chain Visualization ---

function FallbackChain({
  attempts,
  success,
}: {
  attempts: LogAttempt[];
  success: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {attempts.map((attempt, index) => {
        const isLast = index === attempts.length - 1;
        const isFailed = !!attempt.error || !!attempt.reason;
        const isSuccess = isLast && success;

        return (
          <div key={index} className="flex items-center gap-2">
            {/* Provider Node */}
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                isSuccess
                  ? 'border-green-500/30 bg-green-500/5'
                  : isFailed
                  ? 'border-red-500/30 bg-red-500/5'
                  : 'border-border bg-card'
              }`}
            >
              {isSuccess ? (
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              ) : isFailed ? (
                <XCircle className="h-4 w-4 text-red-500 shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
              )}
              <div className="text-sm">
                <div className="font-medium">{attempt.provider}</div>
                <div className="text-xs text-muted-foreground font-mono">{attempt.model}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">
                    {attempt.latencyMs}ms
                  </span>
                  {isFailed && attempt.reason && (
                    <Badge variant="outline" className={`text-xs ${getReasonDisplay(attempt.reason).color}`}>
                      {getReasonDisplay(attempt.reason).label}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Arrow between nodes */}
            {!isLast && (
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}
