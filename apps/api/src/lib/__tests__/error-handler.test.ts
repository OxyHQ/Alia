import { describe, it, expect } from 'vitest';
import {
  translateError,
  formatErrorResponse,
  isRetryableError,
  sanitizeMessage,
  validateUserSafeMessage,
  AliaErrorCode,
  PROVIDER_NAMES,
  USER_ERROR_MESSAGES,
} from '../error-handler.js';

describe('error-handler', () => {
  describe('translateError', () => {
    it('maps rate limit errors correctly', () => {
      const error = new Error('Rate limit exceeded');
      const result = translateError(error, 'openai', 'gpt-4');

      expect(result.code).toBe(AliaErrorCode.RATE_LIMIT_EXCEEDED);
      expect(result.retryable).toBe(true);
      expect(result.retryAfterSeconds).toBe(60);
    });

    it('maps 429 status code to rate limit', () => {
      const error = { message: 'Too Many Requests', status: 429 };
      const result = translateError(error, 'anthropic', 'claude-3');

      expect(result.code).toBe(AliaErrorCode.RATE_LIMIT_EXCEEDED);
      expect(result.retryable).toBe(true);
    });

    it('maps overload errors correctly', () => {
      const error = new Error('Service overloaded');
      const result = translateError(error, 'anthropic', 'claude-3');

      expect(result.code).toBe(AliaErrorCode.MODEL_OVERLOADED);
      expect(result.retryable).toBe(true);
    });

    it('maps timeout errors correctly', () => {
      const error = new Error('Request timed out (ETIMEDOUT)');
      const result = translateError(error, 'groq', 'llama-3');

      expect(result.code).toBe(AliaErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });

    it('maps context length errors as non-retryable', () => {
      const error = new Error('Maximum context length exceeded');
      const result = translateError(error, 'openai', 'gpt-4');

      expect(result.code).toBe(AliaErrorCode.CONTEXT_LENGTH_EXCEEDED);
      expect(result.retryable).toBe(false);
    });

    it('maps auth errors as non-retryable', () => {
      const error = new Error('Invalid API key (401)');
      const result = translateError(error, 'google', 'gemini-pro');

      expect(result.code).toBe(AliaErrorCode.AUTHENTICATION_REQUIRED);
      expect(result.retryable).toBe(false);
    });

    it('defaults to INTERNAL_ERROR for unknown errors', () => {
      const error = new Error('Something completely unexpected');
      const result = translateError(error);

      expect(result.code).toBe(AliaErrorCode.INTERNAL_ERROR);
      expect(result.retryable).toBe(true);
    });
  });

  describe('provider name leakage prevention', () => {
    it('NEVER includes provider names in userMessage', () => {
      const providers = ['openai', 'anthropic', 'google', 'groq', 'deepseek', 'mistral'];
      const errors = [
        new Error('OpenAI rate limit exceeded'),
        new Error('Anthropic service overloaded'),
        new Error('Google API key invalid'),
        new Error('Groq timeout'),
        new Error('DeepSeek billing issue'),
        new Error('Mistral context length exceeded'),
      ];

      for (let i = 0; i < errors.length; i++) {
        const result = translateError(errors[i], providers[i], 'model-x');
        const lowerMessage = result.userMessage.toLowerCase();

        for (const providerName of PROVIDER_NAMES) {
          expect(lowerMessage).not.toContain(providerName.toLowerCase());
        }
      }
    });

    it('NEVER includes provider names in formatted error response', () => {
      const error = translateError(
        new Error('OpenAI GPT-4 rate limit exceeded (429)'),
        'openai',
        'gpt-4'
      );
      const response = formatErrorResponse(error);

      const responseStr = JSON.stringify(response).toLowerCase();
      for (const providerName of PROVIDER_NAMES) {
        expect(responseStr).not.toContain(providerName.toLowerCase());
      }
    });

    it('all user error messages are provider-free', () => {
      for (const [code, message] of Object.entries(USER_ERROR_MESSAGES)) {
        const lowerMessage = message.toLowerCase();
        for (const providerName of PROVIDER_NAMES) {
          expect(lowerMessage).not.toContain(providerName.toLowerCase());
        }
      }
    });
  });

  describe('sanitizeMessage', () => {
    it('replaces provider names with Alia', () => {
      expect(sanitizeMessage('OpenAI returned an error')).toBe('Alia returned an error');
      expect(sanitizeMessage('Anthropic service is down')).toBe('Alia service is down');
      expect(sanitizeMessage('Google Gemini failed')).toBe('Alia Alia failed');
    });

    it('removes all traces of provider model names', () => {
      // "gpt-" is in PROVIDER_NAMES so it gets replaced first by sanitizeMessage
      const sanitized = sanitizeMessage('gpt-4-turbo failed');
      expect(sanitized.toLowerCase()).not.toContain('gpt');

      const sanitized2 = sanitizeMessage('claude-3-sonnet is overloaded');
      expect(sanitized2.toLowerCase()).not.toContain('claude');
    });

    it('handles case insensitive replacement', () => {
      expect(sanitizeMessage('OPENAI error')).toBe('Alia error');
      expect(sanitizeMessage('Anthropic error')).toBe('Alia error');
    });
  });

  describe('validateUserSafeMessage', () => {
    it('passes for clean messages', () => {
      expect(() => validateUserSafeMessage('Something went wrong')).not.toThrow();
      expect(() => validateUserSafeMessage('Please try again')).not.toThrow();
    });

    it('throws for messages containing provider names', () => {
      expect(() => validateUserSafeMessage('OpenAI returned 429')).toThrow('SECURITY VIOLATION');
      expect(() => validateUserSafeMessage('Anthropic is down')).toThrow('SECURITY VIOLATION');
      expect(() => validateUserSafeMessage('Error from Groq')).toThrow('SECURITY VIOLATION');
    });
  });

  describe('formatErrorResponse', () => {
    it('includes expected fields', () => {
      const error = translateError(new Error('Test error'));
      const response = formatErrorResponse(error);

      expect(response.error).toBeDefined();
      expect(response.error.code).toBeDefined();
      expect(response.error.message).toBeDefined();
      expect(response.error.retryable).toBeDefined();
    });
  });

  describe('isRetryableError', () => {
    it('returns true for retryable errors', () => {
      const error = translateError(new Error('Rate limit exceeded'));
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for non-retryable errors', () => {
      const error = translateError(new Error('Context length exceeded'));
      expect(isRetryableError(error)).toBe(false);
    });
  });
});
