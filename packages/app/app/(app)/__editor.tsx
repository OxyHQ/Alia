// Local visual check of the agent editor panel — never committed (see .git/info/exclude).
// Open http://localhost:8150/__editor
import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { queryKeys } from '@/shared/api/query-keys';

const AGENT = {
  _id: 'x',
  oxyAccountId: 'acct',
  name: 'Pepe',
  handle: 'pepe',
  character: { preset: 'blue_beret' },
  color: 'blue',
  tagline: 'finds things out',
  description: 'a description',
  systemPrompt: 'you are helpful',
  author: 'me',
  authorName: 'Nate',
  category: 'Research',
  tags: [],
  rating: 0,
  isPublished: false,
  archetype: 'general',
  archetypeConfig: {},
  skills: [],
  starters: [],
  access: 'private',
};

export default function EditorCheck() {
  const client = useQueryClient();
  useEffect(() => {
    client.setQueryData(queryKeys.agents.detail('x'), AGENT);
    useUIStore.getState().openAgentEditor('x');
  }, [client]);
  return <AiChatContainer title="Editor check">{null}</AiChatContainer>;
}
