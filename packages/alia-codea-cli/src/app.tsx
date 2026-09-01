import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { MessageList, DisplayMessage } from './components/MessageList.js';
import { InputBar } from './components/InputBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { processConversation, Message, ToolExecution } from './utils/conversation.js';
import { buildSystemMessage, getCodebaseContext, loadProjectInstructions } from './utils/context.js';
import { createSession, saveSession } from './utils/config.js';
import { ApprovalMode, parseApprovalMode } from './utils/approval.js';
import { fetchCatalogue, fetchModes, labelFor, matchShorthand, presentation } from './utils/catalogue.js';

export interface AppOptions {
  model: string;
  approvalMode: ApprovalMode;
  context: boolean;
}

const APPROX_MAX_CONTEXT_CHARS = 128_000;

export function App({ options }: { options: AppOptions }) {
  const { exit } = useApp();
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState('Thinking');
  /**
   * The chosen model and how to show it, in ONE piece of state.
   *
   * They were two, and the display was derived by stripping an `kaana-v1-`
   * prefix off the identifier — which rendered `kaana-lite` as `kaana-lite` and
   * only ever shortened one family. The catalogue supplies the real name, and
   * that arrives asynchronously, so keeping the pair together is what stops the
   * label describing a model the request no longer carries. Until the catalogue
   * has been consulted the identifier IS the label, which is honest rather than
   * pretty.
   */
  const [selection, setSelection] = useState({ id: options.model, label: options.model });
  const model = selection.id;
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
  const msgCounterRef = useRef(0);

  const nextId = useCallback(() => `msg-${++msgCounterRef.current}`, []);

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
      /**
       * Resolve the header's label once the catalogue can be asked.
       *
       * `selection` starts with the identifier in both halves — honest, because
       * nothing has been consulted yet — and this is the consultation. It never
       * throws and never blocks readiness: `labelFor` returns the identifier
       * unchanged when the catalogue cannot be read, so the header degrades to
       * exactly what it showed before.
       */
      const label = await labelFor(options.model);
      if (!cancelled) setSelection((current) => (current.id === options.model ? { ...current, label } : current));
    })();
    return () => { cancelled = true; };
  }, []);

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) {
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

  const handleSubmit = useCallback(async (userInput: string) => {
    // Handle slash commands
    if (userInput.startsWith('/')) {
      const [cmd, ...args] = userInput.slice(1).split(' ');
      switch (cmd.toLowerCase()) {
        case 'help':
          addMessage({
            id: nextId(),
            type: 'info',
            content: 'Commands: /help, /clear, /mode <suggest|auto-edit|full-auto>, /model <name>, /exit',
            // `/model` keeps its address: `/mode` is already taken, two lines
            // to the left, by the approval mode. What it CHANGES is described
            // in the product's own words everywhere the command answers.
          });
          return;
        case 'clear':
          messagesRef.current = [];
          setDisplayMessages([]);
          setContextPercent(100);
          return;
        case 'mode': {
          const parsed = parseApprovalMode(args[0]);
          if (args[0] && parsed === args[0]) {
            setApprovalMode(parsed);
            addMessage({ id: nextId(), type: 'info', content: `Approval mode: ${parsed}` });
          } else {
            addMessage({ id: nextId(), type: 'info', content: `Current mode: ${approvalMode}. Options: suggest, auto-edit, full-auto` });
          }
          return;
        }
        case 'model':
          if (args[0]) {
            /**
             * The shorthand is matched against the CATALOGUE rather than
             * expanded with a naming scheme. `kaana-v1-${arg}` produced
             * identifiers that had never existed and sent them anyway; an
             * unknown shorthand now says so instead of guessing.
             */
            const shorthand = args[0];
            void (async () => {
              const [entries, modes] = await Promise.all([
                fetchCatalogue().catch(() => null),
                fetchModes().catch(() => []),
              ]);
              const matched = entries === null ? null : matchShorthand(shorthand, entries);
              if (matched === null) {
                addMessage({
                  id: nextId(),
                  type: 'info',
                  content: entries === null
                    ? `Could not read the catalogue; unchanged (${selection.label}).`
                    : `Nothing matches "${shorthand}". Available: ${entries
                        .filter((e) => e.chatVisible)
                        .map((e) => presentation(e, modes).label)
                        .join(', ')}`,
                });
                return;
              }
              /**
               * The product's word for the profile, never the alias display
               * name it came from.
               *
               * This printed `Model: Kaana Lite` — an alias name under the word
               * "model", which is #139's non-negotiable invariant broken in
               * both of the ways it names at once.
               */
              const label = presentation(matched, modes).label;
              setSelection({ id: matched.id, label });
              addMessage({ id: nextId(), type: 'info', content: `Answering in ${label} mode.` });
            })();
          } else {
            void (async () => {
              const label = await labelFor(model);
              addMessage({ id: nextId(), type: 'info', content: `Answering in ${label} mode.` });
            })();
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
    addMessage({ id: nextId(), type: 'user', content: userInput });
    messagesRef.current.push({ role: 'user', content: userInput });

    setIsProcessing(true);
    activeRef.current = true;
    streamingIdRef.current = null;

    const systemMessage = buildSystemMessage(codebaseContext, instructions);

    await processConversation({
      messages: messagesRef.current,
      systemMessage,
      model,
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
    setContextPercent(Math.max(5, 100 - Math.floor((totalChars / APPROX_MAX_CONTEXT_CHARS) * 100)));
  }, [approvalMode, model, codebaseContext, instructions, nextId, addMessage, updateLastAssistant, finalizeAssistant, exit]);

  const handleApprovalResolve = useCallback((approved: boolean) => {
    if (pendingApproval) {
      pendingApproval.resolve(approved);
      setPendingApproval(null);
    }
  }, [pendingApproval]);

  const modelDisplay = selection.label;

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
