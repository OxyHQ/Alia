/**
 * Prompt Loader
 * Dynamically loads and combines system prompts from markdown files
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

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
    // In dev mode (tsx): __dirname is src/lib, need ../../prompts
    // In prod mode (bundled): __dirname is dist, need ../prompts
    // Try dev path first, then prod path
    let promptPath = join(__dirname, '../../prompts', `${promptName}.md`);

    try {
      const content = await readFile(promptPath, 'utf-8');
      promptCache.set(promptName, content);
      return content;
    } catch {
      // Try production path
      promptPath = join(__dirname, '../prompts', `${promptName}.md`);
      const content = await readFile(promptPath, 'utf-8');
      promptCache.set(promptName, content);
      return content;
    }
  } catch (error) {
    log.general.error({ err: error, promptName }, 'Error loading prompt');
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
      log.general.warn({ modelId }, 'No specific prompt found, using base only');
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
    log.general.error({ err: error, modelId }, 'Error building prompt');
    return 'You are Alia, a helpful AI assistant.'; // Fallback
  }
}

/**
 * Clear the prompt cache (useful for development/testing)
 */
export function clearPromptCache(): void {
  promptCache.clear();
}
