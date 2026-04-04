// ── Welcome / Suggestion Types ──

export interface WelcomeSuggestion {
  id: string;
  title: string;
  description: string;
}

// ── Research Types ──

export interface ResearchSource {
  id: number;
  url: string;
  title: string;
}

export interface ResearchProgress {
  phase?: string;
  message?: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
  isComplete?: boolean;
  sources?: ResearchSource[];
  totalSearches?: number;
}

// ── Color Types ──

/** Color interface used by SDK components that need resolved color values (e.g., Markdown renderer). */
export interface ClarityColors {
  text: string;
  muted: string;
  border: string;
  primary: string;
  mutedForeground: string;
  [key: string]: string;
}
