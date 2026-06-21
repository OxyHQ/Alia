import { useState, useRef, useCallback, useEffect } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { useOxy } from '@oxyhq/services';
import { generateAPIUrl } from '@/lib/generate-api-url';
import { PERSONALITY_STYLE_MAP, type PersonalityStyleId } from '@/lib/personality-styles';

function pickRandom<T>(arr: T[], count: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

export function usePersonalitySamplePhrase() {
  const { oxyServices } = useOxy();
  const [phrase, setPhrase] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheRef = useRef<Map<PersonalityStyleId, string>>(new Map());

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const fetchPhrase = useCallback(
    (styleId: PersonalityStyleId) => {
      const style = PERSONALITY_STYLE_MAP[styleId];
      if (!style) return;

      // Return cached phrase if available
      const cached = cacheRef.current.get(styleId);
      if (cached) {
        setPhrase(cached);
        return;
      }

      // Show static greeting immediately as placeholder
      setPhrase(style.sampleGreeting);

      // Cancel any in-flight stream
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setIsStreaming(true);
        setPhrase('');

        try {
          const token = oxyServices.getAccessToken();
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const examples = pickRandom(style.subtitles, 2);

          const res = await expoFetch(generateAPIUrl('/v1/chat/completions'), {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: 'alia-lite',
              stream: true,
              max_tokens: 80,
              temperature: 0.95,
              messages: [
                {
                  role: 'system',
                  content: `Adopt the "${style.name}" personality for this message only. Voice: ${style.tagline}. Examples of this voice:\n- "${examples[0] || ''}"\n- "${examples[1] || ''}"`,
                },
                {
                  role: 'user',
                  content: `Greet me as if I just opened the app. One or two sentences max. Make it personal — reference what you know about me (my name, job, interests, location, anything). Be natural, not generic. Never say "as your AI" or mention being an AI. Just greet me like a real person would in the "${style.name}" style. Output only the greeting, nothing else.`,
                },
              ],
            }),
            signal: controller.signal,
          });

          if (!res.ok || !res.body) {
            if (!controller.signal.aborted) setPhrase(style.sampleGreeting);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let accumulated = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done || controller.signal.aborted) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              const data = trimmed.slice(6);
              if (data === '[DONE]') break;

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  accumulated += delta;
                  setPhrase(accumulated);
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }

          if (!accumulated && !controller.signal.aborted) {
            setPhrase(style.sampleGreeting);
          } else if (accumulated && !controller.signal.aborted) {
            cacheRef.current.set(styleId, accumulated);
          }
        } catch (err: any) {
          if (err.name === 'AbortError') return;
          setPhrase(style.sampleGreeting);
        } finally {
          if (!controller.signal.aborted) {
            setIsStreaming(false);
          }
        }
      }, 300);
    },
    [oxyServices],
  );

  return { phrase, isStreaming, fetchPhrase };
}
