/** Product prompts are internal bootstrap state; request roles never override them. */
export function productAgentClientContext(
  clientContext: string | undefined,
  applicationId: string | null | undefined,
): string | undefined {
  return applicationId == null ? clientContext : undefined;
}

export function withoutProductAgentSystemMessages<T extends { role: string }>(
  messages: readonly T[],
  applicationId: string | null | undefined,
): T[] {
  return applicationId == null
    ? [...messages]
    : messages.filter((message) => message.role !== 'system' && message.role !== 'developer');
}
