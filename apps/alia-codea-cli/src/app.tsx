import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { MessageList, DisplayMessage } from './components/MessageList.js';
import { InputBar } from './components/InputBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { processConversation, Message, ToolExecution } from './utils/conversation.js';
import { buildSystemMessage, getCodebaseContext, loadProjectInstructions } from './utils/context.js';
import { createSession, saveSession } from './utils/config.js';
import { ApprovalMode } from './utils/approval.js';

export interface AppOptions {
  model: string;
  approvalMode: ApprovalMode;
  context: boolean;
}

let msgCounter = 0;
function nextId(): string {
  return `msg-${++msgCounter}`;
}

export function App({ options }: { options: AppOptions }) {
  const { exit } = useApp();
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState('Thinking');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(options.approvalMode);
  const [contextPercent, setContextPercent] = useState(100);
  const [pendingApproval, setPendingApproval] = useState<{
    execution: ToolExecution;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [codebaseContext, setCodebaseContext] = useState('');
  const [instructions, setInstructions] = useState('');

  const messagesRef = useRef<Message[]>([]);
  const sessionRef = useRef(createSession());
  const activeRef = useRef(true);
  const streamingIdRef = useRef<string | null>(null);

  // Initialize on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let ctx = '';
      let instr = '';
      if (options.context !== false) {
        ctx = await getCodebaseContext();
        if (ctx && !cancelled) {
          setDisplayMessages((prev) => [
            ...prev,
            { id: nextId(), type: 'info', content: `Loaded context from ${ctx.split('\n').length} lines` },
          ]);
        }
      }
      instr = await loadProjectInstructions();
      if (instr && !cancelled) {
        const count = instr.split('\n---\n').length;
        setDisplayMessages((prev) => [
          ...prev,
          { id: nextId(), type: 'info', content: `Loaded ${count} CODEA.md instruction file(s)` },
        ]);
      }
      if (!cancelled) {
        setCodebaseContext(ctx);
        setInstructions(instr);
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Handle Ctrl+C
  useInput((_input, key) => {
    if (key.ctrl && (_input === 'c' || _input === 'C')) {
      if (isProcessing) {
        activeRef.current = false;
        setIsProcessing(false);
        setPendingApproval(null);
        setDisplayMessages((prev) => [
          ...prev,
          { id: nextId(), type: 'info', content: 'Cancelled.' },
        ]);
      } else {
        exit();
      }
    }
  });

  const addMessage = useCallback((msg: DisplayMessage) => {
    setDisplayMessages((prev) => [...prev, msg]);
  }, []);

  const updateLastAssistant = useCallback((text: string) => {
    setDisplayMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.type === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return prev;
    });
  }, []);

  const finalizeAssistant = useCallback(() => {
    setDisplayMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.type === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, streaming: false }];
      }
      return prev;
    });
  }, []);

  const handleSubmit = useCallback(async (input: string) => {
    // Handle slash commands
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(' ');
      switch (cmd.toLowerCase()) {
        case 'help':
          addMessage({
            id: nextId(),
            type: 'info',
            content: 'Commands: /help, /clear, /mode <suggest|auto-edit|full-auto>, /model <name>, /exit',
          });
          return;
        case 'clear':
          messagesRef.current = [];
          setDisplayMessages([]);
          setContextPercent(100);
          return;
        case 'mode':
          if (args[0] && ['suggest', 'auto-edit', 'full-auto'].includes(args[0])) {
            setApprovalMode(args[0] as ApprovalMode);
            addMessage({ id: nextId(), type: 'info', content: `Approval mode: ${args[0]}` });
          } else {
            addMessage({ id: nextId(), type: 'info', content: `Current mode: ${approvalMode}. Options: suggest, auto-edit, full-auto` });
          }
          return;
        case 'model':
          if (args[0]) {
            options.model = args[0].startsWith('alia-') ? args[0] : `alia-v1-${args[0]}`;
            addMessage({ id: nextId(), type: 'info', content: `Model: ${options.model}` });
          } else {
            addMessage({ id: nextId(), type: 'info', content: `Current model: ${options.model}` });
          }
          return;
        case 'exit':
        case 'quit':
          exit();
          return;
        default:
          addMessage({ id: nextId(), type: 'info', content: `Unknown command: /${cmd}` });
          return;
      }
    }

    // Add user message
    addMessage({ id: nextId(), type: 'user', content: input });
    messagesRef.current.push({ role: 'user', content: input });

    setIsProcessing(true);
    activeRef.current = true;
    streamingIdRef.current = null;

    const systemMessage = buildSystemMessage(options.model, codebaseContext, instructions);

    await processConversation({
      messages: messagesRef.current,
      systemMessage,
      model: options.model,
      approvalMode,
      isActive: () => activeRef.current,
      requestApproval: (execution) => {
        return new Promise<boolean>((resolve) => {
          setPendingApproval({ execution, resolve });
        });
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'thinking':
            setThinkingLabel('Thinking');
            // Start a new streaming assistant message
            streamingIdRef.current = nextId();
            setDisplayMessages((prev) => [
              ...prev,
              { id: streamingIdRef.current!, type: 'assistant', content: '', streaming: true },
            ]);
            break;
          case 'content':
            updateLastAssistant(event.text);
            break;
          case 'tool_start':
            // Finalize any streaming text before showing tool
            finalizeAssistant();
            setThinkingLabel(`Running ${event.execution.tool}`);
            addMessage({
              id: nextId(),
              type: 'tool',
              content: '',
              toolExecution: { ...event.execution },
            });
            break;
          case 'tool_done':
            // Update the tool message with result
            setDisplayMessages((prev) => {
              const idx = prev.findLastIndex(
                (m) => m.type === 'tool' && m.toolExecution?.id === event.execution.id
              );
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = {
                  ...updated[idx],
                  toolExecution: { ...event.execution },
                };
                return updated;
              }
              return prev;
            });
            break;
          case 'done':
            finalizeAssistant();
            break;
          case 'error':
            finalizeAssistant();
            addMessage({ id: nextId(), type: 'info', content: `Error: ${event.message}` });
            break;
        }
      },
    });

    setIsProcessing(false);
    setPendingApproval(null);

    // Save session
    const session = sessionRef.current;
    session.messages = messagesRef.current.map((m) => ({ role: m.role, content: m.content }));
    session.title = messagesRef.current[0]?.content.slice(0, 50) || 'New conversation';
    session.updatedAt = Date.now();
    saveSession(session);

    // Update context estimate
    const totalChars = messagesRef.current.reduce((acc, m) => acc + m.content.length, 0);
    const maxContext = 128000;
    setContextPercent(Math.max(5, 100 - Math.floor((totalChars / maxContext) * 100)));
  }, [approvalMode, codebaseContext, instructions, options]);

  const handleApprovalResolve = useCallback((approved: boolean) => {
    if (pendingApproval) {
      pendingApproval.resolve(approved);
      setPendingApproval(null);
    }
  }, [pendingApproval]);

  const modelDisplay = options.model.replace('alia-v1-', '');

  return (
    <Box flexDirection="column">
      <Header
        cwd={process.cwd()}
        model={modelDisplay}
        approvalMode={approvalMode}
        contextPercent={contextPercent}
      />
      <MessageList messages={displayMessages} />
      {pendingApproval ? (
        <ApprovalPrompt
          execution={pendingApproval.execution}
          onResolve={handleApprovalResolve}
        />
      ) : (
        <InputBar
          onSubmit={handleSubmit}
          isProcessing={isProcessing}
          thinkingLabel={thinkingLabel}
        />
      )}
    </Box>
  );
}
