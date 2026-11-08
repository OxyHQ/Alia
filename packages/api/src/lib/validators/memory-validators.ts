import { z } from 'zod';

// Settings update schema (`PUT /memory/settings`). What Alia remembers about a person is Nilo's.
export const MemorySettingsSchema = z.object({
  autoSaveEnabled: z.boolean().optional(),
  recallEnabled: z.boolean().optional(),
});
