/**
 * Metrics — In-Memory Metrics Collection (Prometheus-Compatible Format)
 *
 * Collects key platform metrics:
 *   - Agent session duration, steps, token usage
 *   - Tool call latency and error rates
 *   - Provider error rates and latency
 *   - Context compaction events
 *   - MCP tool health
 *
 * Exposes a /metrics endpoint compatible with Prometheus scraping.
 */


export interface MetricSample {
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export type MetricType = 'counter' | 'gauge' | 'histogram';

interface MetricDef {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
  /** For histograms: bucket boundaries */
  buckets?: number[];
}

class MetricsRegistry {
  private metrics = new Map<string, MetricDef>();

  /** Define a new metric */
  register(name: string, help: string, type: MetricType, buckets?: number[]): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, { name, help, type, samples: [], buckets });
    }
  }

  /** Increment a counter */
  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'counter') return;

    const existing = this.findSample(metric, labels);
    if (existing) {
      existing.value += value;
      existing.timestamp = Date.now();
    } else {
      metric.samples.push({ value, labels, timestamp: Date.now() });
    }
  }

  /** Set a gauge value */
  set(name: string, labels: Record<string, string> = {}, value: number): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'gauge') return;

    const existing = this.findSample(metric, labels);
    if (existing) {
      existing.value = value;
      existing.timestamp = Date.now();
    } else {
      metric.samples.push({ value, labels, timestamp: Date.now() });
    }
  }

  /** Observe a histogram value */
  observe(name: string, labels: Record<string, string> = {}, value: number): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'histogram') return;

    // Store raw observation — aggregate on export
    metric.samples.push({ value, labels, timestamp: Date.now() });

    // Cap samples to prevent unbounded growth (keep last 10K)
    if (metric.samples.length > 10_000) {
      metric.samples = metric.samples.slice(-5_000);
    }
  }

  /** Export all metrics in Prometheus text format */
  export(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric.type === 'histogram') {
        lines.push(...this.exportHistogram(metric));
      } else {
        for (const sample of metric.samples) {
          const labelStr = formatLabels(sample.labels);
          lines.push(`${metric.name}${labelStr} ${sample.value}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  private exportHistogram(metric: MetricDef): string[] {
    const buckets = metric.buckets || [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
    const lines: string[] = [];

    // Group samples by labels
    const groups = new Map<string, number[]>();
    for (const sample of metric.samples) {
      const key = JSON.stringify(sample.labels);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(sample.value);
    }

    for (const [key, values] of groups) {
      const labels = JSON.parse(key) as Record<string, string>;
      const sum = values.reduce((a, b) => a + b, 0);
      const count = values.length;

      for (const bucket of buckets) {
        const bucketCount = values.filter(v => v <= bucket).length;
        lines.push(`${metric.name}_bucket${formatLabels({ ...labels, le: String(bucket) })} ${bucketCount}`);
      }
      lines.push(`${metric.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${metric.name}_sum${formatLabels(labels)} ${sum}`);
      lines.push(`${metric.name}_count${formatLabels(labels)} ${count}`);
    }

    return lines;
  }

  private findSample(metric: MetricDef, labels: Record<string, string>): MetricSample | undefined {
    return metric.samples.find(s => {
      const keys = Object.keys(labels);
      if (keys.length !== Object.keys(s.labels).length) return false;
      return keys.every(k => s.labels[k] === labels[k]);
    });
  }
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

// ── Global Registry + Pre-defined Metrics ──

const registry = new MetricsRegistry();

// Agent metrics
registry.register('alia_agent_sessions_total', 'Total agent sessions', 'counter');
registry.register('alia_agent_session_duration_seconds', 'Agent session duration', 'histogram', [1, 5, 10, 30, 60, 120, 300]);
registry.register('alia_agent_steps_total', 'Total agent steps taken', 'counter');
registry.register('alia_agent_tokens_total', 'Total tokens consumed by agents', 'counter');

// Tool metrics
registry.register('alia_tool_calls_total', 'Total tool calls', 'counter');
registry.register('alia_tool_call_duration_seconds', 'Tool call duration', 'histogram', [0.1, 0.5, 1, 2, 5, 10, 30]);
registry.register('alia_tool_errors_total', 'Total tool call errors', 'counter');

// Provider metrics
registry.register('alia_provider_requests_total', 'Total provider API requests', 'counter');
registry.register('alia_provider_errors_total', 'Total provider errors', 'counter');
registry.register('alia_provider_latency_seconds', 'Provider request latency', 'histogram', [0.5, 1, 2, 5, 10, 30]);

// Context metrics
registry.register('alia_context_compaction_total', 'Context compaction events', 'counter');
registry.register('alia_context_tokens_saved', 'Tokens saved by compaction', 'gauge');

// Chat metrics
registry.register('alia_chat_requests_total', 'Total chat API requests', 'counter');
registry.register('alia_chat_stream_duration_seconds', 'Chat stream duration', 'histogram', [0.5, 1, 2, 5, 10, 30]);

// ── Convenience Functions ──

export function agentSessionStarted(labels: { agentId?: string; userId?: string }): void {
  registry.inc('alia_agent_sessions_total', labels);
}

export function agentSessionEnded(durationSec: number, labels: { agentId?: string; status?: string }): void {
  registry.observe('alia_agent_session_duration_seconds', labels, durationSec);
}

export function agentStepTaken(labels: { agentId?: string; modelId?: string }): void {
  registry.inc('alia_agent_steps_total', labels);
}

export function agentTokensUsed(count: number, labels: { agentId?: string; modelId?: string }): void {
  registry.inc('alia_agent_tokens_total', labels, count);
}

export function toolCallRecorded(toolName: string, durationSec: number, success: boolean): void {
  const labels = { tool: toolName };
  registry.inc('alia_tool_calls_total', labels);
  registry.observe('alia_tool_call_duration_seconds', labels, durationSec);
  if (!success) registry.inc('alia_tool_errors_total', labels);
}

export function providerRequestRecorded(provider: string, modelId: string, durationSec: number, success: boolean): void {
  const labels = { provider, model: modelId };
  registry.inc('alia_provider_requests_total', labels);
  registry.observe('alia_provider_latency_seconds', labels, durationSec);
  if (!success) registry.inc('alia_provider_errors_total', labels);
}

export function contextCompactionRecorded(tokensSaved: number): void {
  registry.inc('alia_context_compaction_total');
  registry.set('alia_context_tokens_saved', {}, tokensSaved);
}

export function chatRequestRecorded(durationSec: number, labels: { model?: string; platform?: string }): void {
  registry.inc('alia_chat_requests_total', labels);
  registry.observe('alia_chat_stream_duration_seconds', labels, durationSec);
}

/** Export all metrics in Prometheus text format */
export function exportMetrics(): string {
  return registry.export();
}
