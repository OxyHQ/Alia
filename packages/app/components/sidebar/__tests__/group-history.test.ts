import { describe, it, expect } from "vitest";
import { groupHistory } from "../group-history";
import type { Conversation } from "@/lib/hooks/use-conversations";

describe("history tree grouping", () => {
  it("keeps local-calendar buckets, incoming order and stable keys while omitting empty buckets", () => {
    const now = new Date(2026, 8, 21, 15);
    const row = (id: string, day: number) =>
      ({ id, updatedAt: new Date(2026, 8, day, 12) }) as Conversation;
    const rows = [
      row("a", 21),
      row("b", 21),
      row("c", 20),
      row("d", 17),
      row("e", 2),
    ];
    const result = groupHistory(
      rows,
      ["Today", "Yesterday", "Previous week", "Earlier"],
      now,
    );
    expect(
      result.map((group) => [group.key, group.items.map((item) => item.id)]),
    ).toEqual([
      [0, ["a", "b"]],
      [1, ["c"]],
      [2, ["d"]],
      [3, ["e"]],
    ]);
    expect(
      groupHistory(
        [rows[4]],
        ["Today", "Yesterday", "Previous week", "Earlier"],
        now,
      ).map((group) => group.key),
    ).toEqual([3]);
    expect(rows.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
