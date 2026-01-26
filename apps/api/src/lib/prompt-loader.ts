/**
 * Prompt Loader
 * Dynamically loads and combines system prompts from markdown files
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get directory path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache for loaded prompts
const promptCache = new Map<string, string>();

/**
 * Load a prompt from a markdown file
 */
export async function loadPrompt(promptName: string): Promise<string> {
  // Check cache first
  if (promptCache.has(promptName)) {
    return promptCache.get(promptName)!;
  }

  try {
    const promptPath = join(__dirname, '../prompts', `${promptName}.md`);
    const content = await readFile(promptPath, 'utf-8');

    // Cache the loaded prompt
    promptCache.set(promptName, content);

    return content;
  } catch (error) {
    console.error(`[PromptLoader] Error loading prompt ${promptName}:`, error);
    return '';
  }
}

/**
 * Build a complete system prompt by combining base prompt with model-specific prompt
 * @param modelId - The Alia model ID (e.g., 'alia-v1-codea')
 * @param clientContext - Optional additional context from the client application
 */
export async function buildSystemPrompt(
  modelId: string,
  clientContext?: string
): Promise<string> {
  try {
    // Load model-specific prompt (the core personality)
    const modelPrompt = await loadPrompt(modelId);

    // Load base prompt (shared context like tools, language rules)
    const basePrompt = await loadPrompt('base');

    if (!modelPrompt) {
      console.warn(`[PromptLoader] No specific prompt found for ${modelId}, using base only`);
      return basePrompt + (clientContext ? `\n\n---\n\n${clientContext}` : '');
    }

    // Build the final prompt with layers:
    // 1. Model-specific personality and rules
    // 2. Shared base context (tools, language)
    // 3. Client-specific context (editor, environment)
    let finalPrompt = `${modelPrompt}\n\n---\n\n${basePrompt}`;

    if (clientContext) {
      finalPrompt += `\n\n---\n\n${clientContext}`;
    }

    return finalPrompt;
  } catch (error) {
    console.error(`[PromptLoader] Error building prompt for ${modelId}:`, error);
    return 'You are Alia, a helpful AI assistant.'; // Fallback
  }
}

/**
 * Clear the prompt cache (useful for development/testing)
 */
export function clearPromptCache(): void {
  promptCache.clear();
}
