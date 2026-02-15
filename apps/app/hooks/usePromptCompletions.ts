import { useState, useEffect, useRef } from "react";
import {
  getCompletions,
  type PromptCompletion,
} from "@/lib/prompt-completions";

export function usePromptCompletions(
  inputValue: string,
  enabled = true
): PromptCompletion[] {
  const [completions, setCompletions] = useState<PromptCompletion[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCompletions([]);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2) {
      setCompletions([]);
      return;
    }

    timerRef.current = setTimeout(() => {
      setCompletions(getCompletions(trimmed));
    }, 100);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [inputValue, enabled]);

  return completions;
}
