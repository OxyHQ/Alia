/**
 * The React Query keys of the conversation runtime. The host's persister and its sidebar read
 * the same keys the hooks write, so a list shown anywhere is the list the chat updates.
 */
export const aliaQueryKeys = {
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
  },
};
