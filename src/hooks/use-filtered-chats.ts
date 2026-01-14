import { useMemo } from "react";
import { ChatHistory } from "@/lib/types";

export function useGroupedChats(chatHistory: ChatHistory[]): Record<string, ChatHistory[]> {
  return useMemo(() => {
    const grouped: Record<string, ChatHistory[]> = { "": [] };
    
    for (const chat of chatHistory) {
      const folderId = chat.folderId || "";
      if (!grouped[folderId]) grouped[folderId] = [];
      grouped[folderId].push(chat);
    }
    
    return grouped;
  }, [chatHistory]);
}
