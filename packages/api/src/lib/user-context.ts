/**
 * User Context Builder
 *
 * The `# USER CONTEXT` block a background prompt opens with (Alia's tasks,
 * `routes/internal.ts`). What Alia remembers about the person is not in it: that is Nilo's
 * (`oxy_nilo_memories__*`), recalled by the model. Only the settings the person chose in Alia
 * (language, tone) are.
 *
 * `buildUserContext`, the fetching half that once lived here, had no caller
 * left and appended the person's memory unlabelled; it is gone rather than
 * fixed.
 */

/**
 * The `# USER CONTEXT` block a background prompt opens with, from data the
 * caller already has.
 *
 * ONE copy. There were two, in `lib/trigger-engine.ts` and `routes/internal.ts`,
 * both called `buildTriggerSystemPrompt` and with DIFFERENT signatures — four
 * arguments and three. Duplicated prompt logic with two spellings is the same
 * disease the five tool assemblers had, in miniature, and it had already
 * drifted: one said "The user's name is X" and the other "Name: X", one
 * carried the bio and the tone and the other did not.
 *
 * The task prompt each of them wraps is genuinely different — a scheduled
 * trigger is not a service event — so THAT stays with its caller. What is
 * shared is this, and only this.
 *
 * Takes fetched values rather than a `userId`: both callers already hold them,
 * and re-fetching inside a prompt builder would put an Oxy round trip on a path
 * that has one of its own.
 */
export function formatUserContextLines(
  oxyUser?: {
    name?: { full?: string; first?: string; middle?: string; last?: string };
    username?: string;
    location?: string;
    bio?: string;
  } | null,
  memory?: {
    preferences?: { language?: string; tone?: string };
  } | null,
): string[] {
  const lines: string[] = [];

  if (oxyUser) {
    const fullName =
      oxyUser.name?.full ||
      [oxyUser.name?.first, oxyUser.name?.middle, oxyUser.name?.last].filter(Boolean).join(' ');
    // `'User'` is Oxy's placeholder for an unnamed account, not a name.
    if (fullName && fullName !== 'User') lines.push(`The user's name is ${fullName}.`);
    if (oxyUser.username) lines.push(`The user's username is @${oxyUser.username}.`);
    if (oxyUser.location) lines.push(`The user is located in ${oxyUser.location}.`);
    if (oxyUser.bio) lines.push(`About the user: ${oxyUser.bio}`);
  }

  if (memory) {
    if (memory.preferences?.language) {
      lines.push(`User's preferred language: ${memory.preferences.language}.`);
    }
    if (memory.preferences?.tone) lines.push(`User's preferred tone: ${memory.preferences.tone}.`);
  }

  return lines;
}

/** The block itself, or nothing when there is nothing to say. */
export function userContextBlock(
  oxyUser?: Parameters<typeof formatUserContextLines>[0],
  memory?: Parameters<typeof formatUserContextLines>[1],
): string {
  const lines = formatUserContextLines(oxyUser, memory);
  return lines.length === 0 ? '' : `# USER CONTEXT\n\n${lines.join('\n')}\n\n---\n\n`;
}
