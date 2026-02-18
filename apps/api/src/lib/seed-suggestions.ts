import { Suggestion } from '../models/suggestion.js';
import { log } from './logger.js';

const WELCOME_SUGGESTIONS = [
  {
    suggestionId: 'welcome-summarize',
    title: 'Summarize',
    text: 'Summarize a complex topic, article, or document into clear key points',
    description: 'Summarize a complex topic, article, or document into clear key points',
    type: 'welcome' as const,
    category: 'productivity',
    triggerWords: ['summarize', 'summary', 'key points'],
    tags: ['productivity', 'writing'],
    priority: 10,
  },
  {
    suggestionId: 'welcome-draft-email',
    title: 'Draft an email',
    text: 'Draft a professional email with the right tone for any audience',
    description: 'Draft a professional email with the right tone for any audience',
    type: 'welcome' as const,
    category: 'communication',
    triggerWords: ['draft', 'email', 'write email'],
    tags: ['communication', 'writing'],
    priority: 10,
  },
  {
    suggestionId: 'welcome-explore-ideas',
    title: 'Explore ideas',
    text: 'Brainstorm and explore creative ideas for any project or challenge',
    description: 'Brainstorm and explore creative ideas for any project or challenge',
    type: 'welcome' as const,
    category: 'creative',
    triggerWords: ['explore', 'brainstorm', 'ideas'],
    tags: ['creative', 'brainstorming'],
    priority: 10,
  },
  {
    suggestionId: 'welcome-python-code',
    title: 'Python code',
    text: 'Write, debug, or explain Python code snippets',
    description: 'Write, debug, or explain Python code snippets',
    type: 'welcome' as const,
    category: 'coding',
    triggerWords: ['python', 'code', 'script'],
    tags: ['coding', 'programming'],
    priority: 10,
  },
  {
    suggestionId: 'welcome-translate',
    title: 'Translate text',
    text: 'Translate text between languages naturally',
    description: 'Translate text between languages preserving tone and nuance',
    type: 'welcome' as const,
    category: 'language',
    triggerWords: ['translate', 'language', 'convert'],
    tags: ['language', 'translation'],
    priority: 8,
  },
  {
    suggestionId: 'welcome-plan-trip',
    title: 'Plan a trip',
    text: 'Plan a trip with itinerary, budget, and local tips',
    description: 'Plan a trip with itinerary, budget, and local tips',
    type: 'welcome' as const,
    category: 'lifestyle',
    triggerWords: ['plan', 'trip', 'travel'],
    tags: ['travel', 'planning'],
    priority: 8,
  },
  {
    suggestionId: 'welcome-write-story',
    title: 'Write a story',
    text: 'Write a creative short story on any theme',
    description: 'Write a creative short story on any theme or genre',
    type: 'welcome' as const,
    category: 'creative',
    triggerWords: ['write', 'story', 'creative'],
    tags: ['creative', 'writing'],
    priority: 8,
  },
  {
    suggestionId: 'welcome-analyze-data',
    title: 'Analyze data',
    text: 'Analyze data and find trends, patterns, or insights',
    description: 'Analyze data and find trends, patterns, or insights',
    type: 'welcome' as const,
    category: 'productivity',
    triggerWords: ['analyze', 'data', 'trends'],
    tags: ['analysis', 'data'],
    priority: 8,
  },
  {
    suggestionId: 'welcome-learn-topic',
    title: 'Learn something new',
    text: 'Explain a complex topic in simple terms',
    description: 'Explain a complex topic in simple, easy-to-understand terms',
    type: 'welcome' as const,
    category: 'learning',
    triggerWords: ['explain', 'learn', 'teach'],
    tags: ['education', 'learning'],
    priority: 8,
  },
  {
    suggestionId: 'welcome-debug-code',
    title: 'Debug code',
    text: 'Find and fix bugs in your code',
    description: 'Find and fix bugs in your code with clear explanations',
    type: 'welcome' as const,
    category: 'coding',
    triggerWords: ['debug', 'fix', 'bug'],
    tags: ['coding', 'debugging'],
    priority: 8,
  },
  {
    suggestionId: 'welcome-meal-plan',
    title: 'Meal planning',
    text: 'Plan a week of healthy and delicious meals',
    description: 'Plan a week of healthy and delicious meals with recipes',
    type: 'welcome' as const,
    category: 'lifestyle',
    triggerWords: ['meal', 'cook', 'recipe'],
    tags: ['cooking', 'health'],
    priority: 7,
  },
  {
    suggestionId: 'welcome-compare',
    title: 'Compare options',
    text: 'Compare products, tools, or ideas side by side',
    description: 'Compare products, tools, or ideas with pros and cons',
    type: 'welcome' as const,
    category: 'productivity',
    triggerWords: ['compare', 'versus', 'pros cons'],
    tags: ['analysis', 'comparison'],
    priority: 7,
  },
  {
    suggestionId: 'welcome-review-writing',
    title: 'Review my writing',
    text: 'Review and improve your writing for clarity and impact',
    description: 'Review and improve your writing for clarity, grammar, and impact',
    type: 'welcome' as const,
    category: 'writing',
    triggerWords: ['review', 'writing', 'proofread'],
    tags: ['writing', 'editing'],
    priority: 7,
  },
  {
    suggestionId: 'welcome-build-agent',
    title: 'Build an agent',
    text: 'Create a custom AI agent for a specific task',
    description: 'Create a custom AI agent tailored to your workflow',
    type: 'welcome' as const,
    category: 'agents',
    triggerWords: ['build', 'agent', 'create agent'],
    tags: ['agents', 'automation'],
    priority: 7,
  },
  {
    suggestionId: 'welcome-study-help',
    title: 'Study help',
    text: 'Get help studying for exams or learning new subjects',
    description: 'Get help studying with flashcards, quizzes, and explanations',
    type: 'welcome' as const,
    category: 'learning',
    triggerWords: ['study', 'exam', 'quiz'],
    tags: ['education', 'studying'],
    priority: 7,
  },
  {
    suggestionId: 'welcome-workout',
    title: 'Workout plan',
    text: 'Create a personalized workout routine',
    description: 'Create a personalized workout routine for your fitness goals',
    type: 'welcome' as const,
    category: 'lifestyle',
    triggerWords: ['workout', 'exercise', 'fitness'],
    tags: ['fitness', 'health'],
    priority: 7,
  },
];

// Convert prompt-completions.ts static dictionary to seed data
const AUTOCOMPLETE_SUGGESTIONS: Array<{
  suggestionId: string;
  title: string;
  text: string;
  type: 'autocomplete';
  category: string;
  triggerWords: string[];
  tags: string[];
}> = [];

const SUGGESTIONS_DICT: Record<string, { texts: string[]; category: string; tags: string[] }> = {
  test: {
    texts: [
      'Test any new games or apps you recommend',
      'Test some theories about the universe',
      'Test it out and let me know how it goes!',
      'Test my knowledge on world geography',
    ],
    category: 'general',
    tags: ['testing', 'learning'],
  },
  write: {
    texts: [
      'Write a short story about a robot learning to dream',
      'Write a professional email declining a meeting',
      'Write a poem about the changing seasons',
      'Write a cover letter for a software engineering position',
    ],
    category: 'writing',
    tags: ['writing', 'creative'],
  },
  help: {
    texts: [
      'Help me brainstorm ideas for a birthday party',
      'Help me understand how quantum computing works',
      'Help me plan a week of healthy meals',
      'Help me debug this code snippet',
    ],
    category: 'general',
    tags: ['assistance', 'problem-solving'],
  },
  explain: {
    texts: [
      'Explain the theory of relativity in simple terms',
      'Explain how machine learning algorithms work',
      'Explain the difference between HTTP and HTTPS',
      'Explain blockchain technology like I\'m five',
    ],
    category: 'learning',
    tags: ['education', 'explanation'],
  },
  create: {
    texts: [
      'Create a customer support agent that handles tickets and FAQs',
      'Create a coding assistant that helps with Python and JavaScript',
      'Create a creative writing agent for blog posts and stories',
      'Create a research assistant that summarizes academic papers',
    ],
    category: 'agents',
    tags: ['agents', 'creation'],
  },
  what: {
    texts: [
      'What are the best practices for remote work?',
      'What is the meaning of life according to philosophy?',
      'What should I cook for dinner tonight?',
      'What are some good habits to build this year?',
    ],
    category: 'general',
    tags: ['questions', 'knowledge'],
  },
  how: {
    texts: [
      'How do I start learning a new programming language?',
      'How can I improve my public speaking skills?',
      'How does the stock market actually work?',
      'How to make the perfect cup of coffee',
    ],
    category: 'general',
    tags: ['howto', 'learning'],
  },
  tell: {
    texts: [
      'Tell me a fun fact about space',
      'Tell me about the history of the internet',
      'Tell me a joke to brighten my day',
      'Tell me something interesting about psychology',
    ],
    category: 'general',
    tags: ['facts', 'entertainment'],
  },
  give: {
    texts: [
      'Give me 5 ideas for a weekend project',
      'Give me a summary of today\'s tech news',
      'Give me tips for better sleep',
      'Give me a recipe using only pantry staples',
    ],
    category: 'general',
    tags: ['ideas', 'tips'],
  },
  suggest: {
    texts: [
      'Suggest a good movie for tonight',
      'Suggest some productivity tools I should try',
      'Suggest a travel destination for a solo trip',
      'Suggest books similar to Atomic Habits',
    ],
    category: 'general',
    tags: ['recommendations', 'suggestions'],
  },
  find: {
    texts: [
      'Find the best restaurants near me',
      'Find a good podcast about science',
      'Find free resources to learn design',
      'Find alternatives to popular apps',
    ],
    category: 'general',
    tags: ['search', 'discovery'],
  },
  show: {
    texts: [
      'Show me how to solve a Rubik\'s cube',
      'Show me the steps to start a blog',
      'Show me a simple recipe for pasta',
      'Show me interesting facts about history',
    ],
    category: 'general',
    tags: ['howto', 'tutorial'],
  },
  build: {
    texts: [
      'Build a sales outreach agent for cold emails and follow-ups',
      'Build a data analyst agent that interprets charts and metrics',
      'Build a social media manager agent for scheduling posts',
      'Build a personal finance advisor agent',
    ],
    category: 'agents',
    tags: ['agents', 'building'],
  },
  agent: {
    texts: [
      'An agent that translates between multiple languages in real-time',
      'An agent that generates marketing copy for product launches',
      'An agent that reviews code and suggests improvements',
      'An agent that helps onboard new employees',
    ],
    category: 'agents',
    tags: ['agents', 'automation'],
  },
  team: {
    texts: [
      'A content creation team with a writer, editor, and SEO specialist',
      'A development team with a frontend, backend, and QA agent',
      'A marketing team with a copywriter, designer, and strategist',
      'A support team with a triage agent and specialist agents',
    ],
    category: 'agents',
    tags: ['teams', 'collaboration'],
  },
  make: {
    texts: [
      'Make a to-do list for moving to a new city',
      'Make a simple website from scratch',
      'Make a birthday card message for a friend',
      'Make a comparison chart of smartphones',
    ],
    category: 'general',
    tags: ['creation', 'productivity'],
  },
  plan: {
    texts: [
      'Plan a road trip across the country',
      'Plan my day for maximum productivity',
      'Plan a surprise party for someone special',
      'Plan a learning path for web development',
    ],
    category: 'productivity',
    tags: ['planning', 'organization'],
  },
  compare: {
    texts: [
      'Compare iPhone vs Android for everyday use',
      'Compare React and Vue for web development',
      'Compare remote work vs office work',
      'Compare renting vs buying a home',
    ],
    category: 'general',
    tags: ['comparison', 'analysis'],
  },
  summarize: {
    texts: [
      'Summarize the latest news in technology',
      'Summarize the key ideas of Sapiens by Yuval Noah Harari',
      'Summarize how the internet works in simple terms',
      'Summarize the benefits of meditation',
    ],
    category: 'productivity',
    tags: ['summary', 'analysis'],
  },
  translate: {
    texts: [
      'Translate this paragraph into Spanish',
      'Translate this text into French for me',
      'Translate a greeting into five different languages',
      'Translate this email into professional Japanese',
    ],
    category: 'language',
    tags: ['translation', 'language'],
  },
  analyze: {
    texts: [
      'Analyze the pros and cons of this business idea',
      'Analyze my resume and suggest improvements',
      'Analyze this data and find trends',
      'Analyze the strengths and weaknesses of my writing',
    ],
    category: 'productivity',
    tags: ['analysis', 'evaluation'],
  },
  design: {
    texts: [
      'Design a logo concept for a coffee shop',
      'Design a landing page layout for a startup',
      'Design a daily routine for better health',
      'Design a color palette for a modern website',
    ],
    category: 'creative',
    tags: ['design', 'creative'],
  },
  recommend: {
    texts: [
      'Recommend a good book for someone who likes sci-fi',
      'Recommend the best tools for project management',
      'Recommend a workout routine for busy people',
      'Recommend a study method that actually works',
    ],
    category: 'general',
    tags: ['recommendations', 'advice'],
  },
};

// Build autocomplete suggestions from the dictionary
for (const [triggerWord, data] of Object.entries(SUGGESTIONS_DICT)) {
  for (let i = 0; i < data.texts.length; i++) {
    const text = data.texts[i];
    const slug = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60);
    AUTOCOMPLETE_SUGGESTIONS.push({
      suggestionId: `auto-${triggerWord}-${i}`,
      title: text.split(' ').slice(0, 4).join(' '),
      text,
      type: 'autocomplete',
      category: data.category,
      triggerWords: [triggerWord],
      tags: data.tags,
    });
  }
}

const ALL_SEED_SUGGESTIONS = [
  ...WELCOME_SUGGESTIONS,
  ...AUTOCOMPLETE_SUGGESTIONS,
];

export async function seedSuggestions(): Promise<void> {
  try {
    for (const suggestion of ALL_SEED_SUGGESTIONS) {
      await Suggestion.findOneAndUpdate(
        { suggestionId: suggestion.suggestionId },
        {
          $set: {
            ...suggestion,
            scope: 'global',
            language: 'en',
            isBuiltIn: true,
            isAIGenerated: false,
          },
        },
        { upsert: true }
      );
    }
    log.seed.info({ count: ALL_SEED_SUGGESTIONS.length }, 'Seeded built-in suggestions');
  } catch (error) {
    log.seed.error({ err: error }, 'Error seeding suggestions');
  }
}
