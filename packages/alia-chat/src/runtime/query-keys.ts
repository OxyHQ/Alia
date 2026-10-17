/**
 * The React Query keys of the conversation runtime. The host's persister and its sidebar read
 * the same keys the hooks write, so a list shown anywhere is the list the chat updates.
 */
/** What a conversation list may be narrowed to (`GET /v1/conversations?agentId=&app=`). */
export interface ConversationsFilter {
  /** Only the conversations with this agent. */
  agentId?: string;
  /** Only the conversations started in this app, by its slug (`docs/agent-embedding.md` §6). */
  app?: string;
}

export const aliaQueryKeys = {
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
    /**
     * The person's conversations narrowed to one agent, one app or both: under `all`, so every
     * write to the list reaches it.
     */
    filtered: (filter: ConversationsFilter) =>
      ['conversations', { agentId: filter.agentId, app: filter.app }] as const,
  },
  /** An agent the chat is opened on: its profile and the state of its feature gates. */
  agents: {
    profile: (id: string) => ['alia-agent-profile', id] as const,
    features: (id: string) => ['alia-agent-features', id] as const,
  },
  /** A conversation somebody shared, by its token. */
  shared: (token: string) => ['alia-shared-conversation', token] as const,
  /** An agent's permanent thread: the stretches behind the open conversation, and finding in them. */
  threads: {
    /** The thread itself (which conversation is active): the host's own query lives under it. */
    all: (handle: string) => ['agent-thread', handle] as const,
    /**
     * The history, kept apart from the thread itself: re-reading which conversation is active is
     * cheap and happens whenever a new stretch starts, while the pages behind it are immutable and
     * expensive to refetch.
     */
    messages: (handle: string) => ['agent-thread-messages', handle] as const,
    /** Keyed by the query as typed, so each one is cached and none is re-asked. */
    search: (handle: string, query: string) => ['agent-thread-search', handle, query] as const,
    /** One window of the thread, addressed by the cursor a search hit carries. */
    window: (handle: string, cursor: string) => ['agent-thread-window', handle, cursor] as const,
  },
};
