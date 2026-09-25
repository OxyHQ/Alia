/**
 * The handful of values the composer's parts share now that there is no
 * composer component to hold them.
 *
 * `components/ui/prompt-input/context.tsx` used to be this file plus a React
 * context, and the context was the problem: every part of the bar read its
 * state out of an ambient object, so a tile could not be mounted without a
 * provider and a provider could not be built without casting a partial object
 * through `as unknown as PromptInputContextType` — which every test in that
 * directory did, and which is how a required field came to be `undefined` at
 * runtime in a tree TypeScript had called safe.
 *
 * Bloom's pill owns the field, the add menu, the model menu, the mic and the
 * send control, and it takes them all as props. What is left over — the
 * attachment strip, the drop overlay, the suggestion list — is composed as its
 * SIBLINGS, and siblings talk through props. So this file carries no context,
 * no provider and no hook: only the types they share.
 */

/** One definition, beside the other state the app keeps outside components. */
export type { Attachment } from "@/lib/stores/global-store";
