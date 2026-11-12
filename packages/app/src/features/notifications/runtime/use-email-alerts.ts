import apiClient, {
  getApiSessionSnapshot,
  isCurrentApiSession,
  onApiSessionContextChange,
  type ApiSessionOwner,
} from '@/shared/api/client';
import { EMAIL_ALERTS_MUTATION_KEY, queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useTranslation } from '@/shared/i18n/use-translation';
import { createRandomUuid } from '@/shared/platform/random-uuid';
import {
  getAccountProjection,
  onAccountProjectionChange,
  onAccountProjectionInvalidation,
} from '@/shared/state/account-epoch';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * `GET /notifications/email-alerts`, as this app reads it: Alia about the person's Inbox. The
 * answer also lists each gemie's own mailbox switch; those live in Gemies, not here.
 */
export interface EmailAlerts {
  alia: { enabled: boolean };
}

type Owner = {
  userId: string;
  sessionId: string | null;
  projectionRevision: number;
  api: ApiSessionOwner;
};
type Input = { enabled: boolean; owner: Owner; changeId: string };
type Changes = {
  latest: Map<string, string>;
  pending: Map<string, Set<string>>;
  concurrent: Set<string>;
};
const changesByClient = new WeakMap<QueryClient, Changes>();
function changesFor(client: QueryClient): Changes {
  let changes = changesByClient.get(client);
  if (!changes) {
    changes = { latest: new Map(), pending: new Map(), concurrent: new Set() };
    changesByClient.set(client, changes);
    const registered = changes;
    client.getMutationCache().subscribe((event) => {
      if (
        event.type !== 'removed' ||
        event.mutation.options.mutationKey?.[0] !== EMAIL_ALERTS_MUTATION_KEY[0]
      )
        return;
      const input = event.mutation.state.variables as Input | undefined;
      if (!input?.owner?.api || typeof input.changeId !== 'string') return;
      if (releaseChange(registered, input)) registered.concurrent.delete(groupKey(input.owner));
    });
  }
  return changes;
}
function groupKey(owner: Owner): string {
  return JSON.stringify([
    owner.userId,
    owner.projectionRevision,
    owner.api.bindingRevision,
    owner.api.sessionEpoch,
  ]);
}
function releaseChange(changes: Changes, input: Input): boolean {
  const group = groupKey(input.owner);
  const pending = changes.pending.get(group);
  if (!pending?.has(input.changeId)) return false;
  pending.delete(input.changeId);
  if (changes.latest.get(group) === input.changeId) changes.latest.delete(group);
  if (pending.size) return false;
  changes.pending.delete(group);
  return true;
}
function withEnabled(current: EmailAlerts, enabled: boolean): EmailAlerts {
  return { ...current, alia: { enabled } };
}
const ownerKey = (owner: Owner) =>
  [
    ...queryKeys.emailAlerts,
    owner.userId,
    owner.sessionId,
    owner.projectionRevision,
    owner.api.bindingRevision,
    owner.api.sessionEpoch,
  ] as const;
function owns(owner: Owner): boolean {
  const projection = getAccountProjection();
  return (
    projection.userId === owner.userId &&
    projection.revision === owner.projectionRevision &&
    (projection.sessionId === owner.sessionId || owner.sessionId === null) &&
    isCurrentApiSession(owner.api)
  );
}
async function ownedRequest<T>(
  owner: Owner,
  request: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!owns(owner)) throw new Error('The active account changed');
  const controller = new AbortController();
  const changed = () => {
    if (!owns(owner)) controller.abort();
  };
  const cancel = () => controller.abort();
  const stopProjection = onAccountProjectionInvalidation(changed);
  const stopApi = onApiSessionContextChange(changed);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted || !owns(owner)) throw new Error('The active account changed');
    const result = await request(controller.signal);
    if (!owns(owner)) throw new Error('The active account changed');
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
    stopProjection();
    stopApi();
  }
}

/** "Avísame de emails importantes": Alia's switch, about the person's own Inbox. */
export function useEmailAlerts() {
  const { t } = useTranslation();
  const { isAuthenticated, user, activeSessionId } = useOxy();
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const projection = useSyncExternalStore(
    onAccountProjectionChange,
    getAccountProjection,
    getAccountProjection,
  );
  const apiSnapshot = useSyncExternalStore(
    onApiSessionContextChange,
    getApiSessionSnapshot,
    getApiSessionSnapshot,
  );
  const api = JSON.parse(apiSnapshot) as ApiSessionOwner | null;
  const userId = isAuthenticated ? user?.id : undefined;
  const sessionId = activeSessionId ?? null;
  const owner: Owner | null =
    userId &&
    api?.userId === userId &&
    projection.userId === userId &&
    (projection.sessionId === sessionId || projection.sessionId === null)
      ? { userId, sessionId, projectionRevision: projection.revision, api }
      : null;

  const query = useQuery({
    queryKey: owner ? ownerKey(owner) : [...queryKeys.emailAlerts, null],
    queryFn: ({ signal }): Promise<EmailAlerts> => {
      if (!owner) throw new Error('The active account changed');
      return ownedRequest(
        owner,
        async (requestSignal) =>
          (await apiClient.get<EmailAlerts>(API_ROUTES.emailAlerts, { signal: requestSignal }))
            .data,
        signal,
      );
    },
    enabled: Boolean(owner),
  });
  const mutation = useMutation({
    mutationKey: EMAIL_ALERTS_MUTATION_KEY,
    mutationFn: async ({ enabled, owner, changeId }: Input) => {
      if (changesFor(queryClient).latest.get(groupKey(owner)) !== changeId)
        throw new Error('The alert change was superseded');
      // `agentId: null` is Alia on the wire (Gemies' `PUT /notifications/email-alerts`).
      await ownedRequest(owner, (signal) =>
        apiClient.put(API_ROUTES.emailAlerts, { agentId: null, enabled }, { signal }),
      );
    },
    onMutate: async ({ enabled, owner, changeId }: Input) => {
      const changes = changesFor(queryClient);
      if (!owns(owner) || changes.latest.get(groupKey(owner)) !== changeId)
        throw new Error('The active account changed');
      const key = ownerKey(owner);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (!owns(owner) || changes.latest.get(groupKey(owner)) !== changeId)
        throw new Error('The active account changed');
      const previousEnabled = queryClient.getQueryData<EmailAlerts>(key)?.alia.enabled;
      queryClient.setQueryData<EmailAlerts>(
        key,
        (current) => current && withEnabled(current, enabled),
      );
      return { owner, previousEnabled };
    },
    onError: (_error, input, context) => {
      const changes = changesFor(queryClient);
      if (!owns(input.owner) || changes.latest.get(groupKey(input.owner)) !== input.changeId)
        return;
      if (context?.previousEnabled !== undefined) {
        const previousEnabled = context.previousEnabled;
        queryClient.setQueryData<EmailAlerts>(
          ownerKey(input.owner),
          (current) => current && withEnabled(current, previousEnabled),
        );
      }
      if (mounted.current) toast.error(t('settings.saveFailed'));
    },
    onSettled: (_data, _error, input) => {
      const changes = changesFor(queryClient);
      const group = groupKey(input.owner);
      if (!releaseChange(changes, input)) return;
      const concurrent = changes.concurrent.delete(group);
      if (!owns(input.owner)) return;
      const sessionId = getAccountProjection().sessionId;
      if (!concurrent && input.owner.sessionId === sessionId) return;
      const currentOwner = { ...input.owner, sessionId };
      const key = ownerKey(currentOwner);
      void queryClient.cancelQueries({ queryKey: key, exact: true }, { revert: false }).then(() => {
        if (owns(input.owner) && !changes.pending.has(group)) {
          void queryClient.invalidateQueries({ queryKey: key, exact: true });
        }
      });
    },
  });
  return {
    alerts: query.data,
    loading: query.isPending,
    failed: query.isError,
    setEnabled: (enabled: boolean) => {
      if (!owner || !owns(owner)) return;
      const changes = changesFor(queryClient);
      const group = groupKey(owner);
      const changeId = createRandomUuid();
      changes.latest.set(group, changeId);
      const pending = changes.pending.get(group) ?? new Set<string>();
      if (pending.size) changes.concurrent.add(group);
      pending.add(changeId);
      changes.pending.set(group, pending);
      mutation.mutate({ enabled, owner, changeId });
    },
  };
}
