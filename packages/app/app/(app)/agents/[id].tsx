import { AgentTerminal } from '@/components/agent-terminal';
import { Composer } from '@/components/chat/composer/composer';
import { ActivityGrid } from '@/components/detail/activity-grid';
import { agentTint } from '@/lib/agents/agent-color';
import { agentDisplayName, agentHandle } from '@/lib/agents/identity';
import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';
import { CAPABILITY_FAMILIES } from '@/lib/constants/capability-families';
import {
  errorResponseData,
  errorStatus,
  errorMessage as getErrorMessage,
} from '@/lib/errors/error-utils';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useAgentThreads } from '@/lib/hooks/use-agent-threads';
import { useAgent } from '@/lib/hooks/use-agents';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useAgentFavoritesStore } from '@/lib/stores/agent-favorites-store';
import type { Agent } from '@/lib/types/agents';
import { useColorScheme } from '@/lib/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { Divider } from '@oxy.so/bloom/divider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAlertLine, RiBookmarkFill, RiBookmarkLine } from '@oxy.so/bloom/icons';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiMore2Line } from '@oxy.so/bloom/icons/RiMore2Line';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { Loading } from '@oxy.so/bloom/loading';
import { Rating, RatingInput } from '@oxy.so/bloom/rating';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { confirm } from '@oxy.so/bloom/surfaces';
import { Switch } from '@oxy.so/bloom/switch';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ScrollView, Share, View } from 'react-native';

/** The agent's status, as the tone of Bloom's status dot and badge. */
const STATUS_TONE = {
  active: 'success',
  idle: 'warning',
  offline: 'default',
} as const;

/** A routing log's priority, as a badge tone. */
const PRIORITY_TONE = {
  urgent: 'error',
  high: 'warning',
  medium: 'info',
  low: 'success',
} as const;

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// ─── Report Item ────────────────────────────────────────────────────────────

interface ReportItem {
  _id: string;
  status: 'success' | 'failed' | string;
  createdAt: string;
  durationMs?: number;
  result?: string;
}

function ReportCard({ item }: { item: ReportItem }) {
  const isSuccess = item.status === 'success';
  const preview = (item.result || '').slice(0, 200);
  return (
    <Card appearance="outline">
      <CardBody style={{ gap: 8, paddingVertical: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Badge
            size="label-small"
            variant="subtle"
            color={isSuccess ? 'success' : 'error'}
            content={item.status}
          />
          <View style={{ flex: 1 }} />
          {item.durationMs != null && (
            <Muted>{formatDuration(item.durationMs)}</Muted>
          )}
          <Muted>{formatRelativeTime(item.createdAt)}</Muted>
        </View>
        {preview ? (
          <Text variant="body-regular">
            {preview}
            {(item.result || '').length > 200 ? '…' : ''}
          </Text>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ─── Routing Log Item ───────────────────────────────────────────────────────

interface RoutingLogItem {
  _id: string;
  classification?: {
    category?: string;
    priority?: 'urgent' | 'high' | 'medium' | 'low' | string;
    confidence?: number;
  };
  inboundSummary?: string;
  routedTo?: { type?: string; id?: string; name?: string } | null;
  reasoning?: string;
  status?: string;
  createdAt: string;
}

function RoutingLogCard({ item }: { item: RoutingLogItem }) {
  const priority = item.classification?.priority ?? 'medium';
  const category = item.classification?.category;
  const tone =
    PRIORITY_TONE[priority as keyof typeof PRIORITY_TONE] ?? 'default';
  return (
    <Card appearance="outline">
      <CardBody style={{ gap: 8, paddingVertical: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Badge size="label-small" variant="subtle" color={tone} content={priority} />
          {category ? <Text variant="body-medium">{category}</Text> : null}
          <View style={{ flex: 1 }} />
          <Muted>{formatRelativeTime(item.createdAt)}</Muted>
        </View>
        {item.inboundSummary ? (
          <Text variant="body-regular">{item.inboundSummary}</Text>
        ) : null}
        {item.routedTo?.name || item.status ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {item.routedTo?.name ? <Muted>→ {item.routedTo.name}</Muted> : null}
            {item.status ? (
              <Badge size="label-small" variant="outlined" content={item.status} />
            ) : null}
          </View>
        ) : null}
      </CardBody>
    </Card>
  );
}

type DetailTab = 'overview' | 'reports' | 'routing';

/** A section of the overview: its heading, then its content. */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text variant="headline-semibold">{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** Static chips in a wrapping row — capabilities, tags. */
function ChipList({ items }: { items: string[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {items.map((item, i) => (
        <Chip key={i} size="large">
          {item}
        </Chip>
      ))}
    </View>
  );
}

export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const { colors } = useColorScheme();
  const isLargeScreen = useIsLargeScreen();
  /*
   * One cache, not two. This screen used to copy the fetched agent into local
   * state and then hand-patch that copy after a write — a third place holding
   * the same record, and the reason a change made here could go unseen
   * elsewhere. The query IS the state; a write updates it where it lives.
   */
  const { data: agent, isPending: loading } = useAgent(id);
  const { data: agentThreads = [] } = useAgentThreads(id);
  const setAgent = useCallback(
    (next: Agent) =>
      queryClient.setQueryData(queryKeys.agents.detail(next._id), next),
    [queryClient],
  );

  // Hire input state
  const [showHireInput, setShowHireInput] = useState(false);
  const [taskInput, setTaskInput] = useState('');
  const [hiring, setHiring] = useState(false);

  // Chat

  // Favorites
  const toggleFavorite = useAgentFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useAgentFavoritesStore((s) => s.isFavorite);
  const loadFavorites = useAgentFavoritesStore((s) => s.loadFavorites);

  // Archetype tab state
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [routingLogs, setRoutingLogs] = useState<RoutingLogItem[]>([]);
  const [routingLoading, setRoutingLoading] = useState(false);

  // Review state
  const [reviews, setReviews] = useState<any[]>([]);
  const [userReview, setUserReview] = useState<any>(null);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  // Load reviews
  useEffect(() => {
    if (id) {
      apiClient
        .get(`/agents/${id}/reviews`)
        .then((res) => {
          setReviews(res.data?.reviews || []);
          setUserReview(res.data?.userReview || null);
          if (res.data?.userReview) {
            setReviewRating(res.data.userReview.rating);
            setReviewComment(res.data.userReview.comment || '');
          }
        })
        .catch((err) => console.error('Failed to load reviews:', err));
    }
  }, [id]);

  // Load reports when reports tab becomes active (status_update archetype)
  const archetype = agent?.archetype;
  useEffect(() => {
    if (detailTab !== 'reports' || !id || archetype !== 'status_update') return;
    setReportsLoading(true);
    apiClient
      .get(`/agents/${id}/reports`)
      .then((res) => setReports(res.data?.reports || res.data || []))
      .catch((err) => console.error('Failed to load reports:', err))
      .finally(() => setReportsLoading(false));
  }, [detailTab, id, archetype]);

  // Load routing logs when routing tab becomes active (task_router archetype)
  useEffect(() => {
    if (detailTab !== 'routing' || !id || archetype !== 'task_router') return;
    setRoutingLoading(true);
    apiClient
      .get(`/agents/${id}/routing-logs`)
      .then((res) => setRoutingLogs(res.data?.logs || res.data || []))
      .catch((err) => console.error('Failed to load routing logs:', err))
      .finally(() => setRoutingLoading(false));
  }, [detailTab, id, archetype]);

  const isOwner = !!(user && agent && user.id === agent.author);
  const bookmarked = agent ? isFavorite(agent._id) : false;

  /**
   * The granted families, by label, for the listing.
   *
   * Derived rather than stored: the row carries grant STRINGS, and a family the
   * app does not know about is skipped rather than rendered raw.
   */
  const grantedFamilyLabels = (agent?.capabilityGrants ?? []).flatMap(
    (grant) => {
      const family = CAPABILITY_FAMILIES.find((entry) => entry.id === grant);
      return family === undefined ? [] : [family.label];
    },
  );

  /**
   * Open the thread with this agent. It does not START one.
   *
   * This used to create a conversation and land on `/c/:id`, which was two
   * wrongs at once. A thread with an agent is many ordinary conversations, so
   * creating one is beginning a NEW STRETCH — and somebody pressing a button
   * labelled "Chat" is asking to continue, not to begin. Every press left an
   * empty stretch behind; five presses, five empty rows.
   *
   * Beginning one is a separate act with its own places: the agent can offer it
   * mid-thread, and a person can take that offer. Neither of them is this
   * button.
   *
   * The address is the HANDLE, which is Oxy's and may be unresolved — the thread
   * has no address without one. Saying so is better than navigating to `/@`,
   * which would sit on a loading screen that never resolves.
   */
  const handleChat = useCallback(async () => {
    if (!agent) return;
    const handle = agentHandle(agent);
    if (handle === '') {
      toast.error(t('agents.chatUnavailable'));
      return;
    }
    try {
      const response = await apiClient.post(
        API_ROUTES.agents.threads(agent._id),
        {
          title: `Chat with ${agentDisplayName(agent)}`,
          executionTarget: 'sandbox',
          approvalMode: 'ask',
        },
      );
      router.push({
        pathname: '/(app)/[username]',
        params: {
          username: `@${handle}`,
          threadId: String(response.data.thread.id),
        },
      });
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('agents.threadCreateFailed')));
    }
  }, [agent, router, t]);

  const handleHirePress = () => {
    if (agent?.status !== 'active') {
      toast.error(t('agents.notActive'));
      return;
    }
    setShowHireInput(true);
  };

  const handleHireSubmit = useCallback(async () => {
    if (!agent || !taskInput.trim() || hiring) return;
    setHiring(true);
    try {
      const threadResponse = await apiClient.post(
        API_ROUTES.agents.threads(agent._id),
        {
          title: taskInput.trim().slice(0, 120),
          executionTarget: 'sandbox',
          approvalMode: 'ask',
        },
      );
      const threadId = String(threadResponse.data.thread.id);
      const res = await apiClient.post(
        API_ROUTES.agents.goals(threadId),
        {
          objective: taskInput.trim(),
        },
        {
          headers: {
            'Idempotency-Key': `${agent._id}:${Date.now()}:${Math.random()}`,
          },
        },
      );
      setTaskInput('');
      setShowHireInput(false);
      toast.success(t('agents.taskStarted'));

      const handle = agentHandle(agent);
      if (handle) {
        router.push({
          pathname: '/(app)/[username]',
          params: { username: `@${handle}`, threadId },
        });
      }

      // Open agent panel if session was created
      const sessionId = res.data?.sessionId;
      if (sessionId) {
        const { useUIStore } = await import('@/lib/stores/ui-store');
        useUIStore.getState().openAgentPanel(String(sessionId), agent._id);
      }
    } catch (err: unknown) {
      const status = errorStatus(err);
      const data = errorResponseData(err);
      if (status === 402) {
        toast.error(
          `Insufficient credits. You need ${data?.creditsNeeded || 'more'} credits.`,
        );
        // Open credits panel
        const { useUIStore } = await import('@/lib/stores/ui-store');
        useUIStore.getState().setRightPanel('credits');
      } else if (status === 503) {
        toast.error('Agent infrastructure unavailable. Try again later.');
      } else {
        // Through the extractor, not off the body: `/v1` answers
        // `{ error: { message, type } }`, and handing that object to `toast`
        // is the same React #31 crash deleting a show produced.
        toast.error(getErrorMessage(err, 'Failed to start task'));
      }
    } finally {
      setHiring(false);
    }
  }, [agent, taskInput, hiring, t]);

  const handleShare = async () => {
    if (!agent) return;
    try {
      await Share.share({
        message: `${agent.name} — ${agent.tagline}\nhttps://alia.app/agents/${agent._id}`,
      });
    } catch {
      // user cancelled — no action needed
    }
  };

  const handleBookmark = () => {
    if (!agent) return;
    toggleFavorite(agent._id);
  };

  const handleStatusToggle = async (newStatus: 'active' | 'idle') => {
    if (!agent) return;
    try {
      await apiClient.patch(`/agents/${agent._id}/status`, {
        status: newStatus,
      });
      setAgent({ ...agent, status: newStatus });
    } catch {
      toast.error('Failed to update status');
    }
  };

  const handleSubmitReview = useCallback(async () => {
    if (!agent || !reviewRating || submittingReview) return;
    setSubmittingReview(true);
    try {
      const res = await apiClient.post(`/agents/${agent._id}/reviews`, {
        rating: reviewRating,
        comment: reviewComment.trim(),
      });
      setUserReview(res.data.review);
      setAgent({
        ...agent,
        rating: res.data.rating,
        reviewCount: res.data.reviewCount,
      });
      setShowReviewForm(false);
      toast.success(t('agents.reviewSubmitted'));
      const reviewsRes = await apiClient.get(`/agents/${agent._id}/reviews`);
      setReviews(reviewsRes.data?.reviews || []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Failed to submit review'));
    } finally {
      setSubmittingReview(false);
    }
  }, [agent, reviewRating, reviewComment, submittingReview, t]);

  const handleDeleteReview = useCallback(async () => {
    if (!agent) return;
    const ok = await confirm({
      title: t('agents.deleteReview'),
      description: t('agents.deleteReviewConfirm'),
      confirmLabel: t('agents.deleteReview'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/agents/${agent._id}/reviews`);
      setUserReview(null);
      setReviewRating(0);
      setReviewComment('');
      toast.success(t('agents.reviewDeleted'));
      const [, reviewsRes] = await Promise.all([
        // The rating the deletion changed comes back from the server rather
        // than being recomputed here.
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(agent._id),
        }),
        apiClient.get(`/agents/${agent._id}/reviews`),
      ]);
      setReviews(reviewsRes.data?.reviews || []);
    } catch {
      toast.error('Failed to delete review');
    }
  }, [agent, t, queryClient]);

  if (loading) {
    return <Loading variant="spinner" text={t('common.loading')} style={{ flex: 1 }} />;
  }

  if (!agent) {
    return (
      <EmptyState
        icon={RiRobot2Line}
        title={t('agents.notFound')}
        action={{ label: t('agents.backToAgents'), onPress: () => router.back() }}
      />
    );
  }

  const handle = agentHandle(agent);

  return (
    <View style={{ flex: 1, flexDirection: isLargeScreen ? 'row' : 'column' }}>
      {/* Agent details (full width on mobile) */}
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View
          style={{
            padding: 16,
            gap: 20,
            width: '100%',
            maxWidth: isLargeScreen ? 672 : undefined,
          }}
        >
          {/* Page actions */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <Button
              size="sm"
              tone="neutral"
              appearance="plain"
              icon={RiArrowLeftLine}
              accessibilityLabel={t('pages.agents.back')}
              onPress={() => router.back()}
            />
            <ButtonGroup accessibilityLabel={t('pages.agents.agentActions')}>
              {isOwner ? (
                <ButtonGroupItem
                  onPress={() =>
                    router.push({
                      pathname: '/(app)/agents/edit/[id]',
                      params: { id: agent._id },
                    })
                  }
                >
                  {t('agents.edit')}
                </ButtonGroupItem>
              ) : null}
              <ButtonGroupItem onPress={handleChat}>
                {t('agents.chat')}
              </ButtonGroupItem>
              <ButtonGroupItem onPress={handleHirePress}>
                {agent.price != null
                  ? `${t('agents.startTask')} · ${agent.price} credits`
                  : t('agents.startTask')}
              </ButtonGroupItem>
              <ButtonGroupItem
                iconOnly
                leadingIcon={RiShare2Line}
                accessibilityLabel={t('agents.share')}
                onPress={handleShare}
              />
              <DropdownMenu>
                <DropdownMenuTrigger label="Actions" asChild>
                  <ButtonGroupItem
                    iconOnly
                    leadingIcon={RiMore2Line}
                    accessibilityLabel={t('pages.agents.moreActions')}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    key="bookmark"
                    onPress={handleBookmark}
                    leading={
                      bookmarked ? (
                        <RiBookmarkFill size="sm" />
                      ) : (
                        <RiBookmarkLine size="sm" />
                      )
                    }
                  >
                    {bookmarked
                      ? t('agents.removeBookmark')
                      : t('agents.bookmark')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    key="report"
                    onPress={() => toast.info(t('agents.reportSubmitted'))}
                    leading={<RiAlertLine size="sm" />}
                  >
                    {t('agents.report')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          </View>

          {/* Identity: the mark in its own colour, carrying the status dot. */}
          <View style={{ gap: 6 }}>
            <View style={{ alignSelf: 'flex-start' }}>
              <Badge dot color={STATUS_TONE[agent.status]} placement="bottom-right">
                <IdentityMark
                  size={80}
                  color={agentTint(agent.color, colors)}
                  accessibilityLabel={agentDisplayName(agent)}
                />
              </Badge>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="title-3-semibold">{agentDisplayName(agent)}</Text>
              <Badge
                size="label-small"
                variant="subtle"
                color={STATUS_TONE[agent.status]}
                content={t(
                  `agents.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`,
                )}
              />
            </View>
            {/* Handle + Author — both read from Oxy, both absent when it could
                not resolve the account, so an unresolved agent shows no row of
                separators around nothing. */}
            {(handle !== '' || agent.authorName !== null) && (
              <Muted>
                {[handle !== '' ? `@${handle}` : null, agent.authorName]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </Muted>
            )}
            {agent.tagline ? (
              <Text variant="body-regular">{agent.tagline}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Rating value={agent.rating} count={agent.reviewCount} size="small" />
              <Muted>
                {formatCount(agent.hireCount)} {t('agents.hires')} ·{' '}
                {formatCount(agent.usageCount)} {t('agents.uses')}
              </Muted>
            </View>
          </View>

          {/* Owner controls */}
          {isOwner && (
            <SettingsListGroup>
              <SettingsListItem
                title={agent.status === 'active' ? 'Active' : 'Paused'}
                description={
                  agent.status === 'active'
                    ? 'Accepting hires'
                    : 'Not accepting hires'
                }
                rightElement={
                  <Switch
                    accessibilityLabel="Accepting hires"
                    value={agent.status === 'active'}
                    onValueChange={(on) =>
                      handleStatusToggle(on ? 'active' : 'idle')
                    }
                  />
                }
              />
            </SettingsListGroup>
          )}

          {/* The task for this agent, written in the app's composer. */}
          {showHireInput && (
            <Composer
              value={taskInput}
              onValueChange={setTaskInput}
              onSubmit={handleHireSubmit}
              busy={hiring}
              disabled={hiring}
              placeholder={t('agents.taskPlaceholder')}
            />
          )}

          {/* Archetype tabs */}
          {(agent.archetype === 'status_update' ||
            agent.archetype === 'task_router') && (
            <Tabs
              value={detailTab}
              onValueChange={(next) => setDetailTab(next as DetailTab)}
            >
              <TabsTrigger value="overview" label="Overview" />
              {agent.archetype === 'status_update' ? (
                <TabsTrigger value="reports" label="Reports" />
              ) : (
                <TabsTrigger value="routing" label="Routing" />
              )}
            </Tabs>
          )}

          {/* Reports */}
          {detailTab === 'reports' && agent.archetype === 'status_update' && (
            reportsLoading ? (
              <Loading variant="spinner" size="sm" />
            ) : reports.length === 0 ? (
              <EmptyState variant="compact" title="No reports yet" />
            ) : (
              <View style={{ gap: 8 }}>
                {reports.map((item) => (
                  <ReportCard key={item._id} item={item} />
                ))}
              </View>
            )
          )}

          {/* Routing */}
          {detailTab === 'routing' && agent.archetype === 'task_router' && (
            routingLoading ? (
              <Loading variant="spinner" size="sm" />
            ) : routingLogs.length === 0 ? (
              <EmptyState variant="compact" title="No routing activity yet" />
            ) : (
              <View style={{ gap: 8 }}>
                {routingLogs.map((item) => (
                  <RoutingLogCard key={item._id} item={item} />
                ))}
              </View>
            )
          )}

          {/* Overview (every archetype, while the overview is active) */}
          {detailTab === 'overview' && (
            <>
              {agentThreads.length > 0 && (
                <SettingsListGroup title={t('agents.threads')}>
                  {agentThreads.slice(0, 8).map((thread) => (
                    <SettingsListItem
                      key={thread.id}
                      title={thread.title}
                      titleNumberOfLines={1}
                      description={`${thread.executionTarget === 'cowork' ? 'Cowork' : 'Sandbox'} · ${thread.status}`}
                      value={formatRelativeTime(thread.updatedAt)}
                      onPress={() => {
                        if (handle)
                          router.push({
                            pathname: '/(app)/[username]',
                            params: {
                              username: `@${handle}`,
                              threadId: thread.id,
                            },
                          });
                      }}
                    />
                  ))}
                </SettingsListGroup>
              )}

              <Section title={t('agents.activity')}>
                <ActivityGrid agentId={agent._id} />
              </Section>

              <Divider />

              <Section title={t('agents.about')}>
                <Text variant="body-regular">{agent.description}</Text>
              </Section>

              {/* Capabilities — the families this agent was granted, by their
                  own labels. A connector grant (`mcp:<id>`) is deliberately not
                  shown: the id is meaningless to a reader and the connector
                  belongs to the owner, not to this public listing. */}
              {grantedFamilyLabels.length > 0 && (
                <>
                  <Divider />
                  <Section title={t('agents.capabilities')}>
                    <ChipList items={grantedFamilyLabels} />
                  </Section>
                </>
              )}

              {agent.tags.length > 0 && (
                <>
                  <Divider />
                  <Section title={t('agents.tags')}>
                    <ChipList items={agent.tags} />
                  </Section>
                </>
              )}

              <Divider />
              <Section
                title={t('agents.reviews')}
                action={
                  user && !isOwner && !showReviewForm ? (
                    <Button
                      size="sm"
                      appearance="plain"
                      onPress={() => setShowReviewForm(true)}
                    >
                      {userReview
                        ? t('agents.editReview')
                        : t('agents.writeReview')}
                    </Button>
                  ) : null
                }
              >
                {showReviewForm && (
                  <Card appearance="outline">
                    <CardBody style={{ gap: 12, paddingVertical: 12 }}>
                      <RatingInput
                        value={reviewRating || null}
                        onChange={setReviewRating}
                        accessibilityLabel={t('agents.reviews')}
                      />
                      <Textarea
                        value={reviewComment}
                        onValueChange={setReviewComment}
                        placeholder={t('agents.reviewPlaceholder')}
                        rows={3}
                        autoResize
                      />
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'flex-end',
                          gap: 8,
                        }}
                      >
                        <Button
                          size="sm"
                          tone="neutral"
                          appearance="plain"
                          onPress={() => setShowReviewForm(false)}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          tone="action"
                          onPress={handleSubmitReview}
                          disabled={!reviewRating}
                          loading={submittingReview}
                        >
                          {t('agents.writeReview')}
                        </Button>
                      </View>
                    </CardBody>
                  </Card>
                )}

                {reviews.length === 0 && !showReviewForm ? (
                  <Muted>{t('agents.noReviews')}</Muted>
                ) : (
                  <View style={{ gap: 12 }}>
                    {reviews.map((review: any) => (
                      <View key={review._id} style={{ gap: 4 }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <Text variant="body-medium">
                            {review.userId?.username || 'User'}
                          </Text>
                          <Rating value={review.rating} size="small" />
                          <View style={{ flex: 1 }} />
                          {user && review.userId?._id === user.id && (
                            <Button
                              size="xs"
                              tone="neutral"
                              appearance="plain"
                              icon={RiDeleteBinLine}
                              accessibilityLabel={t('agents.deleteReview')}
                              onPress={handleDeleteReview}
                            />
                          )}
                        </View>
                        {review.comment ? (
                          <Text variant="body-regular">{review.comment}</Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}
              </Section>

              {/* Activity terminal — mobile only; desktop has it beside. */}
              {!isLargeScreen && (
                <>
                  <Divider />
                  <Section title={t('agents.activity')}>
                    <View style={{ height: 300 }}>
                      <AgentTerminal agentId={agent._id} />
                    </View>
                  </Section>
                </>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* Activity terminal beside the details — desktop only */}
      {isLargeScreen && (
        <View style={{ flex: 1, padding: 16, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Badge dot color="success" />
            <Text variant="headline-semibold">{t('agents.activity')}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <AgentTerminal agentId={agent._id} />
          </View>
        </View>
      )}
    </View>
  );
}
