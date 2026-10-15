// @alia.onl/sdk/tools — what a turn's tool calls mean, without the UI.
// Pure functions: the status of a call, the numbered sources of a research answer, the
// words for a tool. They load no React Native, so a host's models and tests can use them.

export {
  citationLabel,
  extractCitationSources,
  linkifyCitations,
  normalizeCitationMarkers,
} from './lib/citations';
export { domainOf } from './lib/domain';
export type { CitationSource } from './lib/citations';
export { getToolDoneLabel, getToolPillLabel } from './lib/task-labels';
export {
  ASK_USER_QUESTION_TOOL,
  askedQuestions,
  formatAnswers,
  isQuestionInvocation,
  pendingQuestions,
} from './lib/questions';
export type { AskedOption, AskedQuestion, QuestionAnswer } from './lib/questions';
export { classifyIntake, MAX_ATTACHMENT_BYTES } from './lib/attachment-intake';
export { toolCallStatus } from './lib/tool-call-status';
export type { ToolCallStatus } from './lib/tool-call-status';
export { englishCopy } from './lib/copy';
export type { Translate } from './lib/copy';
