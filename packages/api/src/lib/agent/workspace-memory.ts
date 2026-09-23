/**
 * Workspace memory — what is left of "the container filesystem as extended
 * context".
 *
 * It mirrored the run's plan into `/workspace/.alia/todo.md`, offloaded large
 * tool results to `/workspace/.alia/observations/` and archived compacted
 * events there, all inside the agent's sandbox container. Every one of those
 * was conditional on a container existing, and none ever did in production:
 * the docker host that would have provided one was never configured, and it is
 * gone (see `terminal-session.ts`). With no container every method was already
 * a no-op, so the behaviour of a run does not change.
 *
 * `agent/actions.ts` still hands the plan to {@link WorkspaceMemory.syncTodo},
 * which is the only reason the class survives.
 */
export class WorkspaceMemory {
  /** No workspace to write the plan into; the plan persists on the session row. */
  async syncTodo(_todoMarkdown: string): Promise<void> {}
}
