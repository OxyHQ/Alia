import { generateUUID } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/globalStore";
import { Redirect } from "expo-router";

const ChatPage = () => {
  const [chatId] = useState(() => generateUUID());

  useEffect(() => {
    useStore.getState().setChatId({ id: chatId, from: "newChat" });
  }, [chatId]);

  return <Redirect href={`/(app)/c/${chatId}`} />;
};

export default ChatPage;
