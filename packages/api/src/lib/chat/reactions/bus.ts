/** The durable reaction state reaches only the owner's existing authenticated socket room. */
export interface ConversationReactionUpdate {
  readonly conversationId: string;
  readonly messageId: string;
  readonly reactions: readonly string[];
  readonly revision: number;
  readonly mutationId: string;
}

/** Call after the mutation commits; HTTP retry and conversation reload repair missed delivery. */
export async function publishConversationReaction(
  userId: string,
  update: ConversationReactionUpdate,
): Promise<void> {
  const { getIO } = await import('../../../socket.js');
  getIO()?.to(`user:${userId}`).emit('conversation:reaction', update);
}
