import { clsx, type ClassValue } from "clsx";
import { Platform } from "react-native";
import { twMerge } from "tailwind-merge";

import { createRandomUuid } from "@/lib/utils/random-uuid";

/**
 * The four helpers this app actually uses.
 *
 * ## What was removed, and why it was worse than dead weight
 *
 * This file carried ~230 further lines from the Vercel `ai-chatbot` template
 * it was started from: `fetcher`, `getLocalStorage`, `convertToUIMessages`,
 * `sanitizeResponseMessages`, `sanitizeUIMessages`, `getMostRecentUserMessage`,
 * `getDocumentTimestampByIndex`, `getMessageIdFromAnnotations`,
 * `isValidYoutubeUrl`, `isIOS` and `isNative`, none of them imported anywhere.
 *
 * The types went with them, and they are the reason this is not merely
 * tidying. A `Message` interface lived here — a DIFFERENT `Message` from the
 * one in `lib/hooks/use-conversations.ts` that the app actually passes around,
 * with a different shape and the same name, one import away from being picked
 * up by autocomplete in a file that meant the real one. `CoreMessage`,
 * `CoreToolMessage`, `CoreAssistantMessage` and `MessageAnnotation` were the
 * same story.
 *
 * They also kept `lib/db/schema.ts` alive: a Drizzle-shaped module for a
 * database this app has never had, whose only importer was the type import at
 * the top of this file. It is deleted with them.
 */

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isWeb() {
  return Platform.OS === "web";
}

/**
 * A UUID that works on every platform this app runs on.
 *
 * `createRandomUuid` is the seam: `crypto.randomUUID` is absent in the Hermes
 * runtime and on insecure web origins, so the choice is made once there rather
 * than at each call site.
 */
export function generateUUID(): string {
  return createRandomUuid();
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  /**
   * Clamped to the unit table.
   *
   * `Math.floor(Math.log(bytes) / Math.log(k))` is unbounded at both ends, and
   * `sizes[i]` is `undefined` outside it — so a file of a terabyte or more read
   * "1 undefined", and any size below one byte (a fractional value, which
   * `attachment.size` can be) took `log` of a number below 1, giving `i = -1`
   * and the same undefined unit. Negative and non-finite inputs went further:
   * `Math.log` of them is `NaN`, and `sizes[NaN]` is undefined too.
   */
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));
  return `${String(Math.round((bytes / Math.pow(k, i)) * 100) / 100)} ${sizes[i]}`;
}
