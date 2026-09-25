/**
 * What a chat turn is sent with — the shapes the chat runtime takes and the
 * voice call hands it.
 *
 * They live here rather than in the chat's runtime because voice drives the
 * same send: a spoken turn is an ordinary turn with `responseMode: 'voice'`.
 * Voice reading them from the chat would make the two features import each
 * other (the chat renders voice's controls), so both read the contract.
 */

/** A file picked in the composer, on its way into a turn. */
export interface Attachment {
  id: string;
  uri: string;
  type: 'image' | 'document';
  name: string;
  size: number;
  mimeType: string;
  isLoading?: boolean;
}

export interface SendOptions {
  /** `null` explicitly withholds MCP tools; omission preserves legacy callers. */
  mcpServerId?: string | null;
  /**
   * The skills chosen for THIS message, by name.
   *
   * Per turn rather than per session: the previous design set one skill id
   * globally when a skill's page was opened, applied it to every conversation,
   * and had nothing that could clear it. Omitted means the person chose none —
   * Alia can still load an installed skill on its own from the index in its
   * system prompt, which is what the format is for.
   */
  skillNames?: string[];
  /**
   * `'voice'` when the turn was spoken in a voice call: the API answers it
   * with its voice response profile — short, conversational, nothing that
   * cannot be read aloud. Omitted for every typed turn.
   */
  responseMode?: 'voice';
  /**
   * Called with the whole answer so far each time real content arrives, before
   * it is batched for rendering. Voice mode speaks from this: it needs every
   * fragment the moment it lands, and the final text before `append` resolves,
   * neither of which the rendered message list guarantees.
   */
  onAnswerText?: (answerSoFar: string) => void;
}
