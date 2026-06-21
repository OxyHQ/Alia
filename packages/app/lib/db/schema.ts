// Minimal schema types for React Native app
// These match the server-side database schema

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | any[];
  createdAt: Date;
  chatId?: string;
}

export interface Document {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  userId: string;
}

export interface Chat {
  id: string;
  createdAt: Date;
  userId: string;
  title?: string;
}

export interface User {
  id: string;
  email: string;
  password?: string;
}
