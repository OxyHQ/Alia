import mongoose, { Schema, Model, Document } from 'mongoose';

export interface ISuggestion extends Document {
  suggestionId: string;
  title: string;
  text: string;
  description?: string;
  isTemplate: boolean;
  templateVariables: string[];
  type: 'welcome' | 'autocomplete';
  category?: string;
  triggerWords: string[];
  scope: 'global' | 'personal';
  oxyUserId?: mongoose.Types.ObjectId;
  language: string;
  usageCount: number;
  priority: number;
  isBuiltIn: boolean;
  isAIGenerated: boolean;
  tags: string[];
  occupations: string[];
  interests: string[];
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SuggestionSchema = new Schema<ISuggestion>({
  suggestionId: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  text: { type: String, required: true },
  description: { type: String },
  isTemplate: { type: Boolean, default: false },
  templateVariables: [{ type: String }],
  type: { type: String, enum: ['welcome', 'autocomplete'], required: true },
  category: { type: String },
  triggerWords: [{ type: String }],
  scope: { type: String, enum: ['global', 'personal'], required: true, default: 'global' },
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  language: { type: String, required: true, default: 'en-US' },
  usageCount: { type: Number, default: 0 },
  priority: { type: Number, default: 0 },
  isBuiltIn: { type: Boolean, default: false },
  isAIGenerated: { type: Boolean, default: false },
  tags: [{ type: String }],
  occupations: [{ type: String }],
  interests: [{ type: String }],
  expiresAt: { type: Date, index: true },
}, { timestamps: true });

// Compound indexes for common queries
SuggestionSchema.index({ scope: 1, language: 1, type: 1 });
SuggestionSchema.index({ oxyUserId: 1, scope: 1 });
SuggestionSchema.index({ triggerWords: 1, language: 1 });
SuggestionSchema.index({ text: 'text', title: 'text' }, { language_override: 'textSearchLang' });

// Pre-save: extract {variable} patterns from text
SuggestionSchema.pre('save', function () {
  const matches = this.text.match(/\{(\w+)\}/g);
  if (matches) {
    this.templateVariables = [...new Set(matches.map(m => m.slice(1, -1)))];
    this.isTemplate = true;
  } else {
    this.templateVariables = [];
    this.isTemplate = false;
  }
});

export const Suggestion: Model<ISuggestion> = mongoose.models.Suggestion || mongoose.model<ISuggestion>('Suggestion', SuggestionSchema);
