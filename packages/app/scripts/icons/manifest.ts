/**
 * The icons Alia draws from the shell sprite sheet, and what each is called.
 *
 * One entry per icon, and one generated component per entry — `generate.ts`
 * writes `src/shared/ui/icons/<file>` and owns that directory outright. Adding
 * an icon is a line here plus `bun run generate:icons`; nothing else is
 * hand-edited, and `src/shared/ui/__tests__/generated-icons.test.ts` fails if the
 * committed files and a fresh run disagree.
 *
 * ## Why a subset rather than all of them
 *
 * The sheet carries 94 symbols. A component nothing renders is dead code, so
 * only what a screen actually draws is generated. The sheet itself is committed
 * next to this file, so the next icon costs one line rather than a hunt for the
 * source art.
 *
 * ## Two symbols were removed from the sheet before committing it
 *
 * As received it carried 96, two of which drew another vendor's logo —
 * `blossom`, and `warning`, which is the same mark inside a triangle. They are
 * gone from `shell-sprites.svg` rather than merely left out of this list,
 * because leaving them there is an invitation: Alia does not name whose model
 * answered, and a logo says it louder than a word would. `generate()` already
 * refuses a symbol the sheet does not carry, so their absence IS the guard.
 * `exclamation-triangle` is the unbranded triangle, and stays.
 *
 * ## `name` is not always `id`
 *
 * The sheet's ids carry its own size and weight suffixes — `chevron-down-sm`,
 * `microphone-regular-24` — which say which ARTWORK was picked, not what the
 * icon means. The component takes the meaning; the `id` stays here so the
 * source symbol is one grep away, and the generator refuses two entries that
 * would land on one file.
 */

export interface IconEntry {
  /** The `<symbol id>` in `shell-sprites.svg`. */
  id: string;
  /** PascalCase component base; the generator appends `Icon` and kebabs the file. */
  name: string;
  /** What this icon means in Alia, for the generated doc comment. */
  purpose: string;
}

export const ICONS: readonly IconEntry[] = [
  { id: 'agent-robot', name: 'AgentRobot', purpose: 'agents — the sidebar section and the delegation capability' },
  { id: 'clock', name: 'Clock', purpose: 'Automations — scheduled triggers, in the sidebar and the agent editor' },
];
