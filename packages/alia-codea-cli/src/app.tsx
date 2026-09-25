import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { MessageList, DisplayMessage } from './components/MessageList.js';
import { InputBar } from './components/InputBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { processConversation, Message, ToolExecution } from './utils/conversation.js';
import { buildSystemMessage, getCodebaseContext, loadProjectInstructions } from './utils/context.js';
import { createSession, saveSession } from './utils/config.js';
import { ApprovalMode, parseApprovalMode } from './utils/approval.js';
import { formatModelList, labelFor, labelForChoice, searchModels, tryCatalogue } from './utils/catalogue.js';

export interface AppOptions {
  /** A `publisher/model` id or search text; `''` for the server's default model. */
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
   * `id` is empty for the server's default model (the request then omits
   * `model`). The catalogue supplies the real name asynchronously, so keeping
   * the pair together is what stops the label describing a model the request
   * no longer carries. Until the catalogue has been consulted the identifier IS
   * the label.
   */
  const [selection, setSelection] = useState({
    id: options.model,
    label: options.model === '' ? 'Default model' : options.model,
  });
  const model = selection.id;
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(options.approvalMode);
  const [contextPercent, setContextPercent] = useState(100);
  const [pendingApproval, setPendingApproval] = useState<{
    execution: ToolExecution;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [codebaseContext, setCodebaseContext] = useState('');
  const [instructions, setInstructions] = useState('');

  const messagesRef = useRef<Message[]>([]);
  const sessionRef = useRef(createSession());
  const activeRef = useRef(true);
  /** The in-flight request of the current turn, so Ctrl+C stops it on the wire. */
  const abortRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const msgCounterRef = useRef(0);

  const nextId = useCallback(() => `msg-${++msgCounterRef.current}`, []);

  // Initialize on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let ctx = '';
      if (options.context !== false) {
        ctx = await getCodebaseContext();
        if (ctx && !cancelled) {
          setDisplayMessages((prev) => [
            ...prev,
            { id: nextId(), type: 'info', content: `Loaded context from ${ctx.split('\n').length} lines` },
          ]);
        }
      }
      const instr = await loadProjectInstructions();
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
      }
      /**
       * Resolve the header's label once the catalogue can be asked. It never
       * throws and never blocks readiness: `labelFor` returns the identifier
       * unchanged when the catalogue cannot be read.
       */
      const label = await labelFor(options.model);
      if (!cancelled) setSelection((current) => (current.id === options.model ? { ...current, label } : current));
    })();
    return () => { cancelled = true; };
  }, [nextId, options.context, options.model]);

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) {
      if (isProcessing) {
        activeRef.current = false;
        // Stop the request itself, not only the rendering of it: a stream
        // nobody reads still runs — and is billed — to completion.
        abortRef.current?.abort();
        setIsProcessing(false);
        /**
         * Settle the approval before dropping it. `requestApproval` hands
         * `processConversation` a promise that ONLY this object's `resolve`
         * can settle (`:242-243`), so clearing the state without calling it
         * left that await pending for the lifetime of the process: the tool
         * loop never reached `isActive()`, the session was never saved, and
         * the abandoned chain kept mutating `messagesRef` behind the
         * cancelled turn. Declining is the honest answer to Ctrl+C.
         */
        pendingApproval?.resolve(false);
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
            content:
              'Commands: /help, /clear, /mode <suggest|auto-edit|full-auto>, ' +
              '/model [id or name | default], /exit',
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
        case 'model': {
          /**
           * `/model` lists the real models; `/model <text>` searches id, name
           * and publisher and switches only on a single match; `/model default`
           * clears the choice so the server's default model answers.
           */
          const query = args.join(' ').trim();
          void (async () => {
            const catalogue = await tryCatalogue();
            if (query === '') {
              addMessage({
                id: nextId(),
                type: 'info',
                content: catalogue === undefined
                  ? `Could not read the model catalogue. Current: ${selection.label}.`
                  : `Current: ${selection.label}\n\n${formatModelList(catalogue, model)}`,
              });
              return;
            }
            if (['default', 'reset', 'clear'].includes(query.toLowerCase())) {
              const label = labelForChoice('', catalogue);
              setSelection({ id: '', label });
              addMessage({ id: nextId(), type: 'info', content: `Using the server's default model: ${label}.` });
              return;
            }
            if (catalogue === undefined) {
              addMessage({
                id: nextId(),
                type: 'info',
                content: `Could not read the model catalogue; unchanged (${selection.label}).`,
              });
              return;
            }
            const matches = searchModels(query, catalogue);
            const only = matches.length === 1 ? matches[0] : undefined;
            if (only !== undefined) {
              setSelection({ id: only.id, label: only.name });
              addMessage({
                id: nextId(),
                type: 'info',
                content: `Model: ${only.name} — ${only.publisher.name} (${only.id})`,
              });
              return;
            }
            addMessage({
              id: nextId(),
              type: 'info',
              content: matches.length === 0
                ? `No model matches "${query}". Type /model to list them.`
                : `"${query}" matches ${matches.length} models; be more specific:\n` +
                  matches
                    .slice(0, 15)
                    .map((m) => `  ${m.name} — ${m.publisher.name}  ${m.id}`)
                    .join('\n') +
                  (matches.length > 15 ? `\n  … and ${matches.length - 15} more` : ''),
            });
          })();
          return;
        }
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
    abortRef.current = new AbortController();
    streamingIdRef.current = null;

    const systemMessage = buildSystemMessage(codebaseContext, instructions);

    await processConversation({
      messages: messagesRef.current,
      systemMessage,
      model,
      approvalMode,
      isActive: () => activeRef.current,
      signal: abortRef.current.signal,
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
  }, [approvalMode, model, selection.label, codebaseContext, instructions, nextId, addMessage, updateLastAssistant, finalizeAssistant, exit]);

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
