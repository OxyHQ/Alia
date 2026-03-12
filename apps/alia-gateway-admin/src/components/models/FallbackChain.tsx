/**
 * FallbackChain - Visual fallback chain for Alia model provider mappings
 *
 * Shows a horizontal flow of provider cards with:
 * - Health status indicators (green/yellow/red dots)
 * - Arrow connectors between providers
 * - Drag & drop reorder (in edit mode)
 * - Quick toggle to enable/disable providers
 * - Priority numbers
 */

import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiClient } from '@/lib/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  ChevronRight,
  GripVertical,
  Activity,
  CircleAlert,
  CircleX,
} from 'lucide-react';
import type { HealthMetrics, AliaModel } from '@/types';

// ─── Types ───────────────────────────────────────────────────

interface ProviderMapping {
  modelConfigId?: string;
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  isActive: boolean;
}

interface FallbackChainProps {
  /** The Alia model to show the chain for */
  model: AliaModel;
  /** If true, allow drag reorder and quick toggles that save to API */
  editable?: boolean;
  /** Compact mode for table rows */
  compact?: boolean;
}

interface FallbackChainEditableProps {
  /** Current provider mappings (form state) */
  mappings: ProviderMapping[];
  /** Callback when mappings change (reorder or toggle) */
  onMappingsChange: (mappings: ProviderMapping[]) => void;
  /** Health data map */
  healthMap?: Map<string, HealthMetrics>;
}

// ─── Health status helpers ───────────────────────────────────

type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

function getHealthStatus(health: HealthMetrics | undefined): HealthStatus {
  if (!health) return 'unknown';
  if (health.circuitState === 'open') return 'down';
  if (health.circuitState === 'half-open') return 'degraded';
  if (!health.isHealthy) return 'degraded';
  if (health.successRate < 50) return 'down';
  if (health.successRate < 90) return 'degraded';
  return 'healthy';
}

function getHealthColor(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-emerald-500';
    case 'degraded':
      return 'bg-yellow-500';
    case 'down':
      return 'bg-red-500';
    case 'unknown':
      return 'bg-zinc-500';
  }
}

function getHealthLabel(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'Healthy';
    case 'degraded':
      return 'Degraded';
    case 'down':
      return 'Down';
    case 'unknown':
      return 'No data';
  }
}

function getHealthIcon(status: HealthStatus) {
  switch (status) {
    case 'healthy':
      return <Activity className="h-3.5 w-3.5 text-emerald-500" />;
    case 'degraded':
      return <CircleAlert className="h-3.5 w-3.5 text-yellow-500" />;
    case 'down':
      return <CircleX className="h-3.5 w-3.5 text-red-500" />;
    case 'unknown':
      return <Activity className="h-3.5 w-3.5 text-zinc-500" />;
  }
}

// ─── Sortable Provider Card ──────────────────────────────────

interface SortableProviderCardProps {
  mapping: ProviderMapping;
  index: number;
  health?: HealthMetrics;
  onToggle?: (index: number, active: boolean) => void;
  editable?: boolean;
}

function SortableProviderCard({ mapping, index, health, onToggle, editable }: SortableProviderCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `${mapping.provider}:${mapping.modelId}:${index}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  };

  const healthStatus = getHealthStatus(health);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        flex items-center gap-2
        ${isDragging ? 'opacity-80' : ''}
      `}
    >
      {/* Arrow connector (skip for first) */}
      {index > 0 && (
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      )}

      <Card
        className={`
          relative shrink-0 transition-all duration-200
          ${!mapping.isActive ? 'opacity-50' : ''}
          ${isDragging ? 'shadow-lg ring-2 ring-primary/50' : ''}
          ${editable ? 'cursor-default' : ''}
        `}
      >
        <CardContent className="p-3 flex items-center gap-3">
          {/* Drag handle */}
          {editable && (
            <button
              {...attributes}
              {...listeners}
              className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none"
              tabIndex={-1}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}

          {/* Health indicator dot */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  {healthStatus === 'healthy' && mapping.isActive && (
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${getHealthColor(healthStatus)} opacity-40`} />
                  )}
                  <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${getHealthColor(healthStatus)}`} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{getHealthLabel(healthStatus)}</span>
                  {health && (
                    <>
                      <span>Success rate: {health.successRate.toFixed(1)}%</span>
                      <span>Latency: {health.averageLatencyMs.toFixed(0)}ms</span>
                      <span>Circuit: {health.circuitState}</span>
                      <span>Requests: {health.totalRequests}</span>
                    </>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Provider info */}
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground capitalize">
                {mapping.provider}
              </span>
              <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-mono">
                P{mapping.priority}
              </Badge>
            </div>
            <code className="text-xs truncate max-w-[140px]">{mapping.modelId}</code>
            {health && (
              <div className="flex items-center gap-1 mt-0.5">
                {getHealthIcon(healthStatus)}
                <span className="text-[10px] text-muted-foreground">
                  {health.successRate.toFixed(0)}% / {health.averageLatencyMs.toFixed(0)}ms
                </span>
              </div>
            )}
          </div>

          {/* Quick toggle */}
          {editable && onToggle && (
            <Switch
              checked={mapping.isActive}
              onCheckedChange={(checked) => onToggle(index, checked)}
              className="ml-2 scale-75"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Read-only Provider Card (for list view) ────────────────

function ProviderCard({
  mapping,
  index,
  health,
}: {
  mapping: ProviderMapping;
  index: number;
  health?: HealthMetrics;
}) {
  const healthStatus = getHealthStatus(health);

  return (
    <div className="flex items-center gap-2">
      {index > 0 && (
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      )}

      <Card
        className={`
          relative shrink-0 transition-all
          ${!mapping.isActive ? 'opacity-50' : ''}
        `}
      >
        <CardContent className="p-3 flex items-center gap-3">
          {/* Health dot */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  {healthStatus === 'healthy' && mapping.isActive && (
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${getHealthColor(healthStatus)} opacity-40`} />
                  )}
                  <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${getHealthColor(healthStatus)}`} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{getHealthLabel(healthStatus)}</span>
                  {health && (
                    <>
                      <span>Success rate: {health.successRate.toFixed(1)}%</span>
                      <span>Latency: {health.averageLatencyMs.toFixed(0)}ms</span>
                      <span>Circuit: {health.circuitState}</span>
                    </>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Provider info */}
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground capitalize">
                {mapping.provider}
              </span>
              <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-mono">
                P{mapping.priority}
              </Badge>
            </div>
            <code className="text-xs truncate max-w-[140px]">{mapping.modelId}</code>
            {health && (
              <div className="flex items-center gap-1 mt-0.5">
                {getHealthIcon(healthStatus)}
                <span className="text-[10px] text-muted-foreground">
                  {health.successRate.toFixed(0)}%{' '}
                  {health.averageLatencyMs > 0 && `/ ${health.averageLatencyMs.toFixed(0)}ms`}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Compact Provider Badge (for table rows) ────────────────

function CompactProviderBadge({
  mapping,
  index,
  health,
}: {
  mapping: ProviderMapping;
  index: number;
  health?: HealthMetrics;
}) {
  const healthStatus = getHealthStatus(health);

  return (
    <div className="flex items-center gap-1">
      {index > 0 && (
        <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant={mapping.isActive ? 'default' : 'secondary'}
              className="text-xs gap-1 cursor-default"
            >
              <span className={`inline-flex rounded-full h-1.5 w-1.5 ${getHealthColor(healthStatus)}`} />
              {mapping.provider}/{mapping.modelId}
              <span className="text-[10px] opacity-70">P{mapping.priority}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">
                {mapping.provider}/{mapping.modelId}
              </span>
              <span>Status: {getHealthLabel(healthStatus)}</span>
              <span>Active: {mapping.isActive ? 'Yes' : 'No'}</span>
              <span>Quality Score: {mapping.qualityScore}</span>
              {health && (
                <>
                  <span>Success rate: {health.successRate.toFixed(1)}%</span>
                  <span>Avg latency: {health.averageLatencyMs.toFixed(0)}ms</span>
                  <span>Circuit: {health.circuitState}</span>
                </>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

// ─── useHealthData hook ──────────────────────────────────────

function useHealthData() {
  const { isAuthenticated } = useAuth();

  const { data } = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => apiClient.getAllProviderHealth(),
    refetchInterval: 30000, // Refresh every 30 seconds
    enabled: isAuthenticated,
  });

  const healthMap = useMemo(() => {
    const map = new Map<string, HealthMetrics>();
    const healthData = (data as any)?.data;
    if (Array.isArray(healthData)) {
      for (const h of healthData) {
        map.set(`${h.provider}:${h.modelId}`, h);
      }
    }
    return map;
  }, [data]);

  return healthMap;
}

// ─── FallbackChain (read-only, for model list) ──────────────

export function FallbackChain({ model, editable = false, compact = false }: FallbackChainProps) {
  const healthMap = useHealthData();
  const queryClient = useQueryClient();

  const sortedMappings = useMemo(
    () => [...model.providerMappings].sort((a, b) => a.priority - b.priority),
    [model.providerMappings]
  );

  // Mutation for quick toggle from the list view
  const toggleMutation = useMutation({
    mutationFn: async ({ mappingIndex, active }: { mappingIndex: number; active: boolean }) => {
      const updatedMappings = sortedMappings.map((m, i) => ({
        provider: m.provider,
        modelId: m.modelId,
        priority: m.priority,
        qualityScore: m.qualityScore,
        isActive: i === mappingIndex ? active : m.isActive,
        ...(m.modelConfigId ? { modelConfigId: m.modelConfigId } : {}),
      }));
      return apiClient.updateAliaModel(model.aliasModelId, { providerMappings: updatedMappings });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alia-models'] });
    },
  });

  // Mutation for reorder from the list view
  const reorderMutation = useMutation({
    mutationFn: async (newMappings: ProviderMapping[]) => {
      const mappingsWithPriority = newMappings.map((m, i) => ({
        provider: m.provider,
        modelId: m.modelId,
        priority: i + 1,
        qualityScore: m.qualityScore,
        isActive: m.isActive,
        ...(m.modelConfigId ? { modelConfigId: m.modelConfigId } : {}),
      }));
      return apiClient.updateAliaModel(model.aliasModelId, { providerMappings: mappingsWithPriority });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alia-models'] });
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sortedMappings.findIndex(
        (m, i) => `${m.provider}:${m.modelId}:${i}` === active.id
      );
      const newIndex = sortedMappings.findIndex(
        (m, i) => `${m.provider}:${m.modelId}:${i}` === over.id
      );

      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(sortedMappings, oldIndex, newIndex);
        reorderMutation.mutate(reordered);
      }
    },
    [sortedMappings, reorderMutation]
  );

  const handleToggle = useCallback(
    (index: number, active: boolean) => {
      toggleMutation.mutate({ mappingIndex: index, active });
    },
    [toggleMutation]
  );

  if (sortedMappings.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">No providers configured</span>
    );
  }

  // Compact mode: inline badges for table rows
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {sortedMappings.map((mapping, index) => (
          <CompactProviderBadge
            key={`${mapping.provider}:${mapping.modelId}:${index}`}
            mapping={mapping}
            index={index}
            health={healthMap.get(`${mapping.provider}:${mapping.modelId}`)}
          />
        ))}
      </div>
    );
  }

  // Editable mode with drag-and-drop
  if (editable) {
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortedMappings.map((m, i) => `${m.provider}:${m.modelId}:${i}`)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex flex-wrap items-center gap-1">
            {sortedMappings.map((mapping, index) => (
              <SortableProviderCard
                key={`${mapping.provider}:${mapping.modelId}:${index}`}
                mapping={mapping}
                index={index}
                health={healthMap.get(`${mapping.provider}:${mapping.modelId}`)}
                onToggle={handleToggle}
                editable
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  }

  // Default: read-only card view
  return (
    <div className="flex flex-wrap items-center gap-1">
      {sortedMappings.map((mapping, index) => (
        <ProviderCard
          key={`${mapping.provider}:${mapping.modelId}:${index}`}
          mapping={mapping}
          index={index}
          health={healthMap.get(`${mapping.provider}:${mapping.modelId}`)}
        />
      ))}
    </div>
  );
}

// ─── FallbackChainEditable (for form dialogs) ───────────────

export function FallbackChainEditable({
  mappings,
  onMappingsChange,
  healthMap,
}: FallbackChainEditableProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const sortedMappings = useMemo(
    () => [...mappings].sort((a, b) => a.priority - b.priority),
    [mappings]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sortedMappings.findIndex(
        (m, i) => `${m.provider}:${m.modelId}:${i}` === active.id
      );
      const newIndex = sortedMappings.findIndex(
        (m, i) => `${m.provider}:${m.modelId}:${i}` === over.id
      );

      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(sortedMappings, oldIndex, newIndex);
        // Reassign priorities
        const withPriorities = reordered.map((m, i) => ({
          ...m,
          priority: i + 1,
        }));
        onMappingsChange(withPriorities);
      }
    },
    [sortedMappings, onMappingsChange]
  );

  const handleToggle = useCallback(
    (index: number, active: boolean) => {
      const updated = sortedMappings.map((m, i) =>
        i === index ? { ...m, isActive: active } : m
      );
      onMappingsChange(updated);
    },
    [sortedMappings, onMappingsChange]
  );

  if (sortedMappings.length === 0) {
    return null;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={sortedMappings.map((m, i) => `${m.provider}:${m.modelId}:${i}`)}
        strategy={horizontalListSortingStrategy}
      >
        <div className="flex flex-wrap items-center gap-1 py-2">
          {sortedMappings.map((mapping, index) => (
            <SortableProviderCard
              key={`${mapping.provider}:${mapping.modelId}:${index}`}
              mapping={mapping}
              index={index}
              health={healthMap?.get(`${mapping.provider}:${mapping.modelId}`)}
              onToggle={handleToggle}
              editable
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// Export the health hook for reuse
export { useHealthData };
