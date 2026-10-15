/**
 * What a chat turn is sent with — the shape the chat runtime takes and the
 * screens hand it.
 *
 * A voice call no longer sends chat turns (it is a realtime session Alia holds,
 * ADR 0017), so nothing here is voice's.
 */

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
}
