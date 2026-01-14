export interface Preset {
  id: string
  name: string
}

export const presets: Preset[] = [
  {
    id: "1",
    name: "Grammar Correction",
  },
  {
    id: "2",
    name: "Summarize for a 2nd grader",
  },
  {
    id: "3",
    name: "Text to command",
  },
  {
    id: "4",
    name: "Q&A",
  },
]
