import mongoose, { Schema, Model, Document } from 'mongoose';

export interface ICanvasComponent {
  id: string;
  type: 'chart' | 'table' | 'code' | 'form' | 'image' | 'markdown' | 'artifact';
  title: string;
  data: Record<string, any>;
  createdAt: Date;
}

export interface ICanvasSession extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  conversationId: string;
  components: ICanvasComponent[];
  createdAt: Date;
  updatedAt: Date;
}

const CanvasComponentSchema = new Schema<ICanvasComponent>({
  id: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: ['chart', 'table', 'code', 'form', 'image', 'markdown', 'artifact'],
  },
  title: { type: String, required: true },
  data: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const CanvasSessionSchema = new Schema<ICanvasSession>({
  oxyUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  conversationId: {
    type: String,
    required: true,
    index: true,
  },
  components: [CanvasComponentSchema],
}, {
  timestamps: true,
});

CanvasSessionSchema.index({ oxyUserId: 1, conversationId: 1 }, { unique: true });

export const CanvasSession: Model<ICanvasSession> = mongoose.models.CanvasSession || mongoose.model<ICanvasSession>('CanvasSession', CanvasSessionSchema);
