export interface Model {
  id: string;
  name: string;
  description: string;
}

// Fallback models (used until API responds)
export const DEFAULT_MODELS: Model[] = [
  { id: "alia-lite", name: "Alia Lite", description: "Fast responses for simple tasks" },
];

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface ModelApiEntry {
  id: string;
  name: string;
  description: string;
}

let cachedModels: Model[] | null = null;

export async function fetchModels(): Promise<Model[]> {
  if (cachedModels) return cachedModels;

  try {
    const response = await fetch(`${API_URL}/v1/models`);
    if (!response.ok) return DEFAULT_MODELS;
    const data = (await response.json()) as { data?: ModelApiEntry[] };
    const models = (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    }));
    cachedModels = models;
    return models;
  } catch {
    return DEFAULT_MODELS;
  }
}

// Backwards-compatible static export (will be replaced by fetchModels in components)
export const MODELS: Model[] = DEFAULT_MODELS;
