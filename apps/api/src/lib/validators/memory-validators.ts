import { z } from 'zod';
import {
  MAX_MEMORY_KEY_LENGTH,
  MAX_MEMORY_VALUE_LENGTH,
  MAX_CATEGORY_LENGTH,
} from '../../models/user-memory';

// Schema for individual memory item
export const MemoryItemSchema = z.object({
  key: z.string()
    .min(1, 'Key is required')
    .max(MAX_MEMORY_KEY_LENGTH, `Key must be less than ${MAX_MEMORY_KEY_LENGTH} characters`)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Key must be alphanumeric with underscores or hyphens only'),
  value: z.string()
    .min(1, 'Value is required')
    .max(MAX_MEMORY_VALUE_LENGTH, `Value must be less than ${MAX_MEMORY_VALUE_LENGTH} characters`),
  category: z.string()
    .max(MAX_CATEGORY_LENGTH, `Category must be less than ${MAX_CATEGORY_LENGTH} characters`)
    .optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

// Schema for preferences
export const PreferencesSchema = z.object({
  language: z.string().max(50).optional(),
  tone: z.string().max(50).optional(),
  responseLength: z.enum(['short', 'medium', 'long']).optional(),
  interests: z.array(z.string().max(100)).max(50, 'Maximum 50 interests allowed').optional(),
}).passthrough(); // Allow additional properties

// Schema for context
export const ContextSchema = z.object({
  occupation: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
  bio: z.string().max(1000).optional(),
}).passthrough(); // Allow additional properties

// Export format schema
export const ExportFormatSchema = z.enum(['json', 'csv']);

// Import memory data schema
export const ImportMemorySchema = z.object({
  version: z.string().optional(),
  exportedAt: z.string().optional(),
  memories: z.array(MemoryItemSchema).max(1000, 'Cannot import more than 1000 memories at once'),
  preferences: PreferencesSchema.optional(),
  context: ContextSchema.optional(),
});

// Merge strategy schema
export const MergeStrategySchema = z.enum(['replace', 'merge', 'skip-duplicates']);

// Memory update schema for API endpoints
export const UpdateMemorySchema = z.object({
  value: z.string()
    .min(1, 'Value is required')
    .max(MAX_MEMORY_VALUE_LENGTH, `Value must be less than ${MAX_MEMORY_VALUE_LENGTH} characters`),
  category: z.string()
    .max(MAX_CATEGORY_LENGTH, `Category must be less than ${MAX_CATEGORY_LENGTH} characters`)
    .optional(),
});

// Add memory schema for API endpoints
export const AddMemorySchema = z.object({
  key: z.string()
    .min(1, 'Key is required')
    .max(MAX_MEMORY_KEY_LENGTH, `Key must be less than ${MAX_MEMORY_KEY_LENGTH} characters`)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Key must be alphanumeric with underscores or hyphens only'),
  value: z.string()
    .min(1, 'Value is required')
    .max(MAX_MEMORY_VALUE_LENGTH, `Value must be less than ${MAX_MEMORY_VALUE_LENGTH} characters`),
  category: z.string()
    .max(MAX_CATEGORY_LENGTH, `Category must be less than ${MAX_CATEGORY_LENGTH} characters`)
    .optional(),
});
