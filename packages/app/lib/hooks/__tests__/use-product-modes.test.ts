import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * The picker's "Automatic / Instant / Thinking / Pro / Research / Code" language
 * comes from `GET /catalogue/modes`, not from a literal in the app — epic #139
 * workstream 5, *"Show 'Automatic/Fast/Quality' language for routing profiles
 * without pretending they are models."*
 *
 * Two things are asserted, because the two failure modes are different:
 *
 *  1. The PARSER reads exactly what the server serves and refuses the shape the
 *     checkbox forbids. The count is an EQUALITY on the fixture, never a floor:
 *     a server that drops a mode must produce five entries here, not "at least
 *     one", or a picker missing a mode looks identical to a picker with all of
 *     them.
 *  2. The PICKER calls the hook and the presentation helper. Asserted with the
 *     opening parenthesis, because an import line also contains the identifier
 *     and a component can import `useProductModes` while rendering a literal —
 *     that is exactly how the previous version of this guard was fooled
 *     (`docs/migration/epic-139-status.md`, `mentionIsNotACall`).
 */

// `use-product-modes.ts` imports the axios client, which reads the native
// runtime for the API host at module load. The client is stood in for; the
// parser and the helpers under test are the real ones.
vi.mock("@/lib/api/client", () => ({ default: { get: vi.fn() } }));

const { parseModes, modeForProfile, modeById, presentation } = await import(
  "@/lib/hooks/use-product-modes"
);
type CatalogueEntry = import("@/lib/hooks/use-catalogue").CatalogueEntry;

/** The wire shape `routes/catalogue.ts` serializes for `GET /catalogue/modes`. */
function serialized(id: string, label: string, profile: string, deepResearch = false) {
  return {
    id,
    object: "product_mode",
    label,
    description: `${label} description`,
    routing: { kind: "profile", profile_id: profile },
    deep_research: deepResearch,
  };
}

const SIX = [
  serialized("mode:auto", "Auto", "route:auto"),
  serialized("mode:instant", "Instant", "route:instant"),
  serialized("mode:thinking", "Thinking", "route:thinking"),
  serialized("mode:pro", "Pro", "route:pro"),
  serialized("mode:research", "Research", "route:research", true),
  serialized("mode:code", "Code", "route:code"),
];

function profileEntry(id: string, displayName: string): CatalogueEntry {
  // Only the fields `presentation` reads. The cast is narrow on purpose: a
  // fixture carrying the whole catalogue shape would be a second copy of it.
  return { kind: "routing_profile", id, displayName, description: `${displayName} (catalogue)` } as unknown as CatalogueEntry;
}

describe("the modes the picker shows are the ones the server served", () => {
  it("parses every mode the endpoint returns, and exactly that many", () => {
    const modes = parseModes({ object: "list", data: SIX });
    expect(modes.map((mode) => mode.id)).toEqual(SIX.map((mode) => mode.id));
    expect(modes.map((mode) => mode.label)).toEqual(["Auto", "Instant", "Thinking", "Pro", "Research", "Code"]);
    expect(modes.find((mode) => mode.id === "mode:research")?.deepResearch).toBe(true);
    expect(modes.find((mode) => mode.id === "mode:code")?.routing).toEqual({ kind: "profile", profileId: "route:code" });
  });

  it("shows five when the server serves five — the mutation the old guard could not see", () => {
    const withoutThinking = SIX.filter((mode) => mode.id !== "mode:thinking");
    const modes = parseModes({ object: "list", data: withoutThinking });
    expect(modes).toHaveLength(5);
    expect(modes.some((mode) => mode.id === "mode:thinking")).toBe(false);
  });

  it("refuses a mode serialized as a model, rather than rendering it as one", () => {
    const asModel = [...SIX.slice(0, 5), { ...SIX[5], object: "model" }];
    expect(() => parseModes({ object: "list", data: asModel })).toThrow();
    // And the control: the same list with the honest object parses.
    expect(parseModes({ object: "list", data: SIX })).toHaveLength(6);
  });

  it("refuses a mode outside the product namespace or without an exact profile", () => {
    expect(() => parseModes({ object: "list", data: [{ ...SIX[0], id: "route:auto" }] })).toThrow();
    expect(() => parseModes({ object: "list", data: [{ ...SIX[0], routing: { kind: "profile", profile_id: " route:auto" } }] })).toThrow();
    expect(() => parseModes({ object: "list", data: [{ ...SIX[0], routing: { kind: "default" } }] })).toThrow();
    expect(() => parseModes({ data: "not a list" })).toThrow();
  });
});

describe("a routing profile is presented in the product's words, never as a model", () => {
  const modes = parseModes({ object: "list", data: SIX });

  it("labels a profile a mode selects with that mode's label", () => {
    expect(presentation(profileEntry("route:instant", "route:instant"), modes)).toEqual({
      label: "Instant",
      description: "Instant description",
    });
    expect(modeForProfile("route:pro", modes)?.id).toBe("mode:pro");
  });

  it("falls back to the catalogue's own name for a profile no mode selects", () => {
    // `route:vision` and the other capability profiles have no product word.
    expect(modeForProfile("route:vision", modes)).toBeNull();
    expect(presentation(profileEntry("route:vision", "Vision"), modes).label).toBe("Vision");
  });

  it("answers null for an ambiguous profile rather than guessing", () => {
    // Two presentation modes on one profile: `mode:pro` repointed at
    // `route:instant` beside `mode:instant`. Neither word is THE word for it.
    const twoOnOne = modes.map((mode) =>
      mode.id === "mode:pro"
        ? { ...mode, routing: { kind: "profile" as const, profileId: "route:instant" } }
        : mode,
    );
    expect(modeForProfile("route:instant", twoOnOne)).toBeNull();
    // The control: the unmodified table answers.
    expect(modeForProfile("route:instant", modes)?.id).toBe("mode:instant");
  });

  it("finds Automatic by its exact id, not by position", () => {
    const reversed = [...modes].reverse();
    expect(modeById("mode:auto", reversed)?.label).toBe("Auto");
    expect(modeById("mode:auto", undefined)).toBeNull();
  });
});

describe("the picker consumes the endpoint (a call, not a mention)", () => {
  const selector = readFileSync(
    fileURLToPath(new URL("../../../components/model-selector.tsx", import.meta.url)),
    "utf8",
  );

  it("calls useProductModes and presentation", () => {
    expect(selector).toMatch(/useProductModes\(\)/);
    expect(selector).toMatch(/presentation\(/);
    expect(selector).toMatch(/modeById\("mode:auto"/);
  });

  it("renders no mode label from a literal", () => {
    // A picker that imported the hook and rendered these words itself would
    // satisfy the call assertion above and still not show what the server serves.
    expect(selector).not.toMatch(/["'>](Auto|Instant|Thinking|Pro|Research|Code)["'<]/);
  });
});
