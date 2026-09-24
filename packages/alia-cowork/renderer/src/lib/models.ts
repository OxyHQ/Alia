/**
 * How the model picker arranges the catalogue the main process hands it
 * (`window.api.listModels`). No model is named here — every row comes from
 * `GET /catalogue`.
 */

/** One model from `GET /catalogue`, as the main process parsed it. */
export interface CatalogueModel {
  id: string
  name: string
  publisher: { id: string; name: string }
  description: string | null
  contextWindow: number | null
  reasoningEfforts: ("low" | "medium" | "high")[]
  featured: boolean
}

/** The catalogue the model picker offers. */
export interface ModelCatalogue {
  models: CatalogueModel[]
  /** What the server uses when a request names no model. */
  defaultModelId: string | null
  featuredIds: string[]
}

export interface ModelGroup {
  /** `null` for the featured group, otherwise the publisher's name. */
  label: string | null
  key: string
  models: CatalogueModel[]
}

/**
 * Featured models first (in `featuredIds` order, else the per-entry flag), then
 * every other model grouped by publisher, publishers alphabetically. A featured
 * model is not repeated under its publisher.
 */
export function groupModels(catalogue: ModelCatalogue): ModelGroup[] {
  const byId = new Map(catalogue.models.map((model) => [model.id, model]))
  const order =
    catalogue.featuredIds.length > 0
      ? catalogue.featuredIds
      : catalogue.models.filter((model) => model.featured).map((model) => model.id)
  const featured: CatalogueModel[] = []
  const featuredSet = new Set<string>()
  for (const id of order) {
    const model = byId.get(id)
    if (model === undefined || featuredSet.has(id)) continue
    featured.push(model)
    featuredSet.add(id)
  }

  const publishers = new Map<string, { name: string; models: CatalogueModel[] }>()
  for (const model of catalogue.models) {
    if (featuredSet.has(model.id)) continue
    const group = publishers.get(model.publisher.id) ?? { name: model.publisher.name, models: [] }
    group.models.push(model)
    publishers.set(model.publisher.id, group)
  }

  const groups: ModelGroup[] = []
  if (featured.length > 0) groups.push({ label: null, key: "featured", models: featured })
  const sorted = [...publishers.entries()].sort(([, a], [, b]) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  )
  for (const [id, group] of sorted) groups.push({ label: group.name, key: id, models: group.models })
  return groups
}

/** "Default" plus, when the server said which, the default model's name. */
export function defaultLabel(catalogue: ModelCatalogue | null): string {
  const id = catalogue?.defaultModelId ?? null
  if (id === null) return "Default"
  const name = catalogue?.models.find((model) => model.id === id)?.name ?? id
  return `Default (${name})`
}

/** Compact context-window size, e.g. `200K`, `1M`. */
export function formatContextWindow(tokens: number | null): string | null {
  if (tokens === null) return null
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}
