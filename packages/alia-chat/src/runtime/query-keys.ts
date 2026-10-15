/**
 * The React Query keys of the conversation runtime. The host's persister and its sidebar read
 * the same keys the hooks write, so a list shown anywhere is the list the chat updates.
 */
export const aliaQueryKeys = {
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
  },
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
