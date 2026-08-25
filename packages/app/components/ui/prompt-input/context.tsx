import React, { createContext, useContext } from "react";
import type { TextInput as RNTextInput } from "react-native";

/**
 * The composer's own corner radius, mirroring the `rounded-[28px]` on the bar in
 * `prompt-input.tsx`. It lives here as a number because the attachment tiles
 * DERIVE their corner from it, and a Tailwind class cannot be read back.
 * `attachments.test.tsx` reads the bar's class and fails if the two drift.
 */
export const COMPOSER_RADIUS = 28;

/**
 * How far the attachment row is inset from the composer's edge — the `px-5` on
 * its content container.
 */
export const ATTACHMENT_ROW_INSET = 20;

/**
 * A tile's corner, concentric with the composer's rather than a number of its
 * own: a rounded box nested inside another looks nested when its radius is the
 * outer one less the gap between them, and merely stuck on top when it is not.
 */
export const ATTACHMENT_TILE_RADIUS = COMPOSER_RADIUS - ATTACHMENT_ROW_INSET;

export interface Attachment {
  id: string;
  uri: string;
  type: "image" | "document";
  name: string;
  size: number;
  mimeType: string;
  isLoading?: boolean;
}

export type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number;
  onSubmit?: () => void;
  /** Send a suggestion's text directly (non-template selections), bypassing the input value. */
  onSuggestionSend?: (text: string) => void;
  disabled?: boolean;
  textareaRef: React.RefObject<RNTextInput | null>;
  currentHeight: number;
  setCurrentHeight: (height: number) => void;
  isFullscreen: boolean;
  onImagePaste?: (files: File[]) => void;
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  updateAttachment: (id: string, updates: Partial<Attachment>) => void;
  handleCompletionKey: ((key: string) => boolean) | null;
  setHandleCompletionKey: React.Dispatch<
    React.SetStateAction<((key: string) => boolean) | null>
  >;
};

export const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  onSuggestionSend: undefined,
  disabled: false,
  textareaRef: React.createRef<RNTextInput>(),
  currentHeight: 44,
  setCurrentHeight: () => {},
  isFullscreen: false,
  attachments: [],
  addAttachment: () => {},
  removeAttachment: () => {},
  updateAttachment: () => {},
  handleCompletionKey: null,
  setHandleCompletionKey: () => {},
});

export function usePromptInput() {
  return useContext(PromptInputContext);
}

export function useIsFullscreen() {
  return useContext(PromptInputContext).isFullscreen;
}
