import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IUserAccessories extends Document<string> {
  _id: string; // Oxy user ID
  ownedAccessories: string[];
  createdAt: Date;
  updatedAt: Date;
}

const UserAccessoriesSchema = new Schema<IUserAccessories>({
  _id: { type: String, required: true },
  ownedAccessories: [{ type: String }],
}, {
  timestamps: true,
});

export const UserAccessories: Model<IUserAccessories> =
  mongoose.models.UserAccessories || mongoose.model<IUserAccessories>('UserAccessories', UserAccessoriesSchema);
