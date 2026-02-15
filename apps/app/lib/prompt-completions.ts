export interface PromptCompletion {
  text: string;
  matchStart: number;
  matchEnd: number;
}

// Full prompt suggestions keyed by trigger words
const SUGGESTIONS: Record<string, string[]> = {
  test: [
    "Test any new games or apps you recommend",
    "Test some theories about the universe",
    "Test it out and let me know how it goes!",
    "Test my knowledge on world geography",
  ],
  write: [
    "Write a short story about a robot learning to dream",
    "Write a professional email declining a meeting",
    "Write a poem about the changing seasons",
    "Write a cover letter for a software engineering position",
  ],
  help: [
    "Help me brainstorm ideas for a birthday party",
    "Help me understand how quantum computing works",
    "Help me plan a week of healthy meals",
    "Help me debug this code snippet",
  ],
  explain: [
    "Explain the theory of relativity in simple terms",
    "Explain how machine learning algorithms work",
    "Explain the difference between HTTP and HTTPS",
    "Explain blockchain technology like I'm five",
  ],
  create: [
    "Create a workout plan for beginners",
    "Create a budget spreadsheet template",
    "Create a study schedule for final exams",
    "Create a list of books to read this year",
  ],
  what: [
    "What are the best practices for remote work?",
    "What is the meaning of life according to philosophy?",
    "What should I cook for dinner tonight?",
    "What are some good habits to build this year?",
  ],
  how: [
    "How do I start learning a new programming language?",
    "How can I improve my public speaking skills?",
    "How does the stock market actually work?",
    "How to make the perfect cup of coffee",
  ],
  tell: [
    "Tell me a fun fact about space",
    "Tell me about the history of the internet",
    "Tell me a joke to brighten my day",
    "Tell me something interesting about psychology",
  ],
  give: [
    "Give me 5 ideas for a weekend project",
    "Give me a summary of today's tech news",
    "Give me tips for better sleep",
    "Give me a recipe using only pantry staples",
  ],
  suggest: [
    "Suggest a good movie for tonight",
    "Suggest some productivity tools I should try",
    "Suggest a travel destination for a solo trip",
    "Suggest books similar to Atomic Habits",
  ],
  find: [
    "Find the best restaurants near me",
    "Find a good podcast about science",
    "Find free resources to learn design",
    "Find alternatives to popular apps",
  ],
  show: [
    "Show me how to solve a Rubik's cube",
    "Show me the steps to start a blog",
    "Show me a simple recipe for pasta",
    "Show me interesting facts about history",
  ],
  make: [
    "Make a to-do list for moving to a new city",
    "Make a simple website from scratch",
    "Make a birthday card message for a friend",
    "Make a comparison chart of smartphones",
  ],
  plan: [
    "Plan a road trip across the country",
    "Plan my day for maximum productivity",
    "Plan a surprise party for someone special",
    "Plan a learning path for web development",
  ],
  compare: [
    "Compare iPhone vs Android for everyday use",
    "Compare React and Vue for web development",
    "Compare remote work vs office work",
    "Compare renting vs buying a home",
  ],
  summarize: [
    "Summarize the latest news in technology",
    "Summarize the key ideas of Sapiens by Yuval Noah Harari",
    "Summarize how the internet works in simple terms",
    "Summarize the benefits of meditation",
  ],
  translate: [
    "Translate this paragraph into Spanish",
    "Translate this text into French for me",
    "Translate a greeting into five different languages",
    "Translate this email into professional Japanese",
  ],
  analyze: [
    "Analyze the pros and cons of this business idea",
    "Analyze my resume and suggest improvements",
    "Analyze this data and find trends",
    "Analyze the strengths and weaknesses of my writing",
  ],
  design: [
    "Design a logo concept for a coffee shop",
    "Design a landing page layout for a startup",
    "Design a daily routine for better health",
    "Design a color palette for a modern website",
  ],
  recommend: [
    "Recommend a good book for someone who likes sci-fi",
    "Recommend the best tools for project management",
    "Recommend a workout routine for busy people",
    "Recommend a study method that actually works",
  ],
};

export function getCompletions(
  input: string,
  maxResults = 4
): PromptCompletion[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length < 2) return [];

  const lower = trimmed.toLowerCase();
  const results: PromptCompletion[] = [];

  for (const suggestions of Object.values(SUGGESTIONS)) {
    for (const text of suggestions) {
      const idx = text.toLowerCase().indexOf(lower);
      if (idx !== -1) {
        results.push({
          text,
          matchStart: idx,
          matchEnd: idx + trimmed.length,
        });
        if (results.length >= maxResults) return results;
      }
    }
  }

  return results;
}
