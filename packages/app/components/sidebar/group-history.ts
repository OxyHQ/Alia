import type { Conversation } from "@/lib/hooks/use-conversations";

/** Keep the history's existing local-calendar buckets and incoming recency order. */
export function groupHistory(
  rows: Conversation[],
  labels: string[],
  now = new Date(),
) {
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const buckets = labels.map((label, key) => ({
    key,
    label,
    items: [] as Conversation[],
  }));
  for (const row of rows) {
    const time = row.updatedAt.getTime();
    const index =
      time >= today
        ? 0
        : time >= today - 86_400_000
          ? 1
          : time >= today - 6 * 86_400_000
            ? 2
            : 3;
    buckets[index].items.push(row);
  }
  return buckets.filter((group) => group.items.length > 0);
}
