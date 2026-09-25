function entry(id: string, name: string, publisher: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: 'model',
    name,
    publisher: { id: id.split('/')[0], name: publisher },
    description: null,
    contextWindow: 200000,
    maxOutput: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: true,
    reasoningEfforts: ['low', 'high'],
    pricing: { inputPerMTok: '3.00', outputPerMTok: '15.00' },
    releasedAt: null,
    featured: false,
    ...extra,
  };
}

/** `GET /catalogue`, in the wire shape. Ids are fixtures, not real defaults. */
export const CATALOGUE = {
  object: 'list',
  data: [
    entry('acme/rocket-1', 'Rocket 1', 'Acme'),
    entry('acme/rocket-1-mini', 'Rocket 1 Mini', 'Acme'),
    entry('globex/sage', 'Sage', 'Globex', { featured: true }),
    entry('initech/tps', 'TPS', 'Initech'),
  ],
  defaultModelId: 'acme/rocket-1',
  featuredIds: ['acme/rocket-1', 'globex/sage'],
};
