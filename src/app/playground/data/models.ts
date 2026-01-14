export const types = ["GPT-3", "Codex"] as const

export type ModelType = (typeof types)[number]

export interface Model {
  id: string
  name: string
  description: string
  strengths?: string
  type: ModelType
}

export const models: Model[] = [
  {
    id: "c-davinci-002",
    name: "davinci-002",
    description:
      "Most capable Codex model. Particularly good at translating natural language to code. In addition to completing code, also supports inserting completions within code.",
    type: "Codex",
    strengths:
      "Complex intent, cause and effect, creative generation, search, summarization for audience",
  },
  {
    id: "c-cushman-001",
    name: "cushman-001",
    description:
      "Almost as capable as Davinci Codex, but slightly faster. This advantage may make it preferable for real-time applications.",
    type: "Codex",
    strengths: "Language translation, complex classification, sentiment, summarization",
  },
  {
    id: "m-davinci-003",
    name: "text-davinci-003",
    description:
      "Most capable GPT-3 model. Can do any task the other models can do, often with higher quality, longer output and better instruction-following. Also supports inserting completions within text.",
    type: "GPT-3",
    strengths:
      "Complex intent, cause and effect, creative generation, search, summarization for audience",
  },
  {
    id: "m-curie-001",
    name: "text-curie-001",
    description: "Very capable, but faster and lower cost than Davinci.",
    type: "GPT-3",
    strengths: "Language translation, complex classification, sentiment, summarization",
  },
  {
    id: "m-babbage-001",
    name: "text-babbage-001",
    description: "Capable of straightforward tasks, very fast, and lower cost.",
    type: "GPT-3",
    strengths: "Moderate classification, semantic search",
  },
  {
    id: "m-ada-001",
    name: "text-ada-001",
    description:
      "Capable of very simple tasks, usually the fastest model in the GPT-3 series, and lowest cost.",
    type: "GPT-3",
    strengths: "Parsing text, simple classification, address correction, keywords",
  },
]
