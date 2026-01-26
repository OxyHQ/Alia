"use client"

import * as React from "react"
import Markdown from "react-markdown"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  PlusSignIcon,
  AttachmentIcon,
  ArrowUp02Icon,
  ArrowDown01Icon,
  Settings01Icon,
  Clock01Icon,
  SparklesIcon,
  CheckmarkCircle02Icon,
  NoteIcon,
  AlertCircleIcon,
  StopIcon,
} from "@hugeicons/core-free-icons"

// Types
interface Message {
  role: "user" | "assistant"
  content: string
  context?: ContextItem[]
  toolExecutions?: ToolExecution[]
}

interface ToolExecution {
  tool: string
  args: Record<string, unknown>
  status: "preparing" | "running" | "success" | "error"
  result?: string
}

interface VSCodeAPI {
  postMessage: (message: unknown) => void
  getState: () => unknown
  setState: (state: unknown) => void
}

declare function acquireVsCodeApi(): VSCodeAPI

// VS Code API singleton
const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null

// Logo URI from extension (set in webview HTML)
const LOGO_URI = (window as unknown as { CODEA_LOGO_URI?: string }).CODEA_LOGO_URI || "/codea-logo.png"

// Permission modes
const permissionModes = [
  { id: "ask", label: "Ask before edits", description: "Asks for approval before making changes", icon: SparklesIcon },
  { id: "edit", label: "Edit automatically", description: "Makes changes without asking", icon: CheckmarkCircle02Icon },
  { id: "plan", label: "Plan mode", description: "Plans changes before executing", icon: NoteIcon },
  { id: "yolo", label: "Bypass permissions", description: "Full autonomous mode", icon: AlertCircleIcon },
]

// Personalized greetings
const greetings = [
  "let's code",
  "ready to build something?",
  "what are we working on?",
  "let's ship some code",
  "what's on the agenda?",
  "let's get creative",
  "time to build",
  "what can I help with?",
  "let's make magic happen",
  "ready when you are",
]

// Tool name to friendly label
const toolLabels: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  delete_file: "Delete",
  list_files: "List",
  search_files: "Search",
  run_command: "Bash",
  set_mode: "Mode",
}

// Thinking phrases like Claude Code
const thinkingPhrases = [
  "Thinking...",
  "Crafting...",
  "Pondering...",
  "Computing...",
  "Processing...",
  "Analyzing...",
  "Reasoning...",
  "Cooking...",
  "Brewing...",
  "Conjuring...",
]

const workingPhrases = [
  "Working...",
  "Executing...",
  "Running...",
  "Building...",
  "Creating...",
  "Doing the thing...",
]

// Animated thinking indicator component
function ThinkingIndicator({ isWorking = false }: { isWorking?: boolean }) {
  const phrases = isWorking ? workingPhrases : thinkingPhrases
  const [phraseIndex, setPhraseIndex] = React.useState(() => Math.floor(Math.random() * phrases.length))
  const [displayText, setDisplayText] = React.useState("")
  const [isTyping, setIsTyping] = React.useState(true)

  React.useEffect(() => {
    const phrase = phrases[phraseIndex]
    let charIndex = 0
    setIsTyping(true)
    setDisplayText("")

    // Type out the phrase
    const typeInterval = setInterval(() => {
      if (charIndex < phrase.length) {
        setDisplayText(phrase.slice(0, charIndex + 1))
        charIndex++
      } else {
        clearInterval(typeInterval)
        setIsTyping(false)

        // Wait then switch to next phrase
        setTimeout(() => {
          setPhraseIndex((prev) => (prev + 1) % phrases.length)
        }, 1500)
      }
    }, 40)

    return () => clearInterval(typeInterval)
  }, [phraseIndex, phrases])

  return (
    <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
      <span className="animate-spin">✱</span>
      <span>
        {displayText}
        {isTyping && <span className="animate-pulse">|</span>}
      </span>
    </div>
  )
}

// Model interface from API
interface Model {
  id: string
  name: string
  description: string
  category?: string
}

// Default models (fallback)
const defaultModels: Model[] = [
  { id: "alia-v1-codea", name: "Codea", description: "Fast coding assistant" },
  { id: "alia-v1-pro", name: "Codea Pro", description: "Advanced reasoning" },
  { id: "alia-v1-thinking", name: "Codea Thinking", description: "Extended thinking for complex tasks" },
]

// Context item interface
interface ContextItem {
  path: string
  content: string
  language: string
}

export function Chat() {
  const [messages, setMessages] = React.useState<Message[]>([])
  const [input, setInput] = React.useState("")
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [currentMode, setCurrentMode] = React.useState("ask")
  const [currentModel, setCurrentModel] = React.useState("alia-v1-codea")
  const [streamingContent, setStreamingContent] = React.useState("")
  const [userName, setUserName] = React.useState<string | null>(null)
  const [toolExecutions, setToolExecutions] = React.useState<ToolExecution[]>([])
  const [models, setModels] = React.useState<Model[]>(defaultModels)
  const [contextItems, setContextItems] = React.useState<ContextItem[]>([])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const streamingContentRef = React.useRef("")

  // Keep ref in sync with state
  React.useEffect(() => {
    streamingContentRef.current = streamingContent
  }, [streamingContent])

  // Handle messages from extension
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data
      console.log('[Codea Webview] Received message:', data.type, data)
      switch (data.type) {
        case "addMessage":
          // Only add assistant messages from extension (user messages are added locally with context)
          if (data.message.role === "assistant") {
            setMessages((prev) => [...prev, data.message])
          }
          break
        case "startAssistantMessage":
          setIsGenerating(true)
          setStreamingContent("")
          streamingContentRef.current = ""
          setToolExecutions([])
          break
        case "streamContent":
          setStreamingContent((prev) => prev + data.content)
          break
        case "endAssistantMessage": {
          setIsGenerating(false)
          // Use ref to get latest streaming content
          const finalContent = streamingContentRef.current
          if (finalContent || toolExecutions.length > 0) {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: finalContent || "",
              toolExecutions: toolExecutions.length > 0 ? [...toolExecutions] : undefined
            }])
          }
          setStreamingContent("")
          streamingContentRef.current = ""
          setToolExecutions([])
          break
        }
        case "error":
          setIsGenerating(false)
          setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.message}` }])
          setStreamingContent("")
          streamingContentRef.current = ""
          setToolExecutions([])
          break
        case "clearChat":
          setMessages([])
          setStreamingContent("")
          streamingContentRef.current = ""
          setToolExecutions([])
          break
        case "userInfo":
          setUserName(data.userName)
          break
        case "toolCall":
          setToolExecutions((prev) => {
            // Check if this tool already exists (from preparing phase)
            const existingIndex = prev.findIndex(t => t.tool === data.tool && t.status === "preparing")
            if (existingIndex >= 0 && data.status === "running") {
              // Update existing preparing entry to running
              return prev.map((t, i) =>
                i === existingIndex ? { ...t, args: data.args, status: "running" } : t
              )
            }
            // Add new entry
            return [...prev, {
              tool: data.tool,
              args: data.args,
              status: data.status || "running"
            }]
          })
          break
        case "toolResult":
          setToolExecutions((prev) =>
            prev.map((t, i) =>
              i === prev.length - 1
                ? { ...t, status: data.success ? "success" : "error", result: data.result }
                : t
            )
          )
          break
        case "models":
          if (data.models && data.models.length > 0) {
            setModels(data.models)
          }
          break
        case "contextAdded":
          if (data.items && data.items.length > 0) {
            setContextItems((prev) => [...prev, ...data.items])
          }
          break
        case "modeChanged":
          if (data.mode) {
            setCurrentMode(data.mode)
          }
          break
      }
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])

  // Auto-scroll to bottom
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingContent, toolExecutions])

  const sendMessage = () => {
    if (!input.trim() || isGenerating) return
    const messageContext = contextItems.length > 0 ? [...contextItems] : undefined
    vscode?.postMessage({
      type: "sendMessage",
      message: input.trim(),
      mode: currentMode,
      model: currentModel,
      context: messageContext
    })
    // Add message with context to local state for display
    setMessages((prev) => [...prev, {
      role: "user",
      content: input.trim(),
      context: messageContext
    }])
    setInput("")
    setContextItems([])
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }

  const removeContextItem = (index: number) => {
    setContextItems((prev) => prev.filter((_, i) => i !== index))
  }

  const stopGeneration = () => {
    vscode?.postMessage({ type: "stopGeneration" })
  }

  const newConversation = () => {
    vscode?.postMessage({ type: "newConversation" })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (isGenerating) {
        stopGeneration()
      } else {
        sendMessage()
      }
    }
  }

  const currentModeConfig = permissionModes.find((m) => m.id === currentMode)

  const hasMessages = messages.length > 0 || streamingContent

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Header - Fixed at top */}
      <header className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => vscode?.postMessage({ type: "showHistory" })}>
              <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Past conversations</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 px-2 h-7">
              <img src={LOGO_URI} alt="Codea" className="size-5 rounded-full" />
              <span className="text-sm font-medium">{models.find(m => m.id === currentModel)?.name || "Codea"}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuRadioGroup value={currentModel} onValueChange={setCurrentModel}>
              {models.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.id}>
                  <Item size="xs" className="p-0">
                    <ItemContent>
                      <ItemTitle>{model.name}</ItemTitle>
                      <ItemDescription className="text-xs">{model.description}</ItemDescription>
                    </ItemContent>
                  </Item>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => vscode?.postMessage({ type: "openSettings" })}>
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={newConversation}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New conversation</TooltipContent>
        </Tooltip>
      </header>

      {/* Messages - Scrollable middle section */}
      <ScrollArea ref={scrollRef} className="flex-1 overflow-auto min-h-0">
        {!hasMessages ? (
          <WelcomeScreen
            userName={userName}
            onSuggestionClick={(text) => {
              setInput(text)
              textareaRef.current?.focus()
            }}
          />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {isGenerating && (
              <>
                {/* Show tool executions - Claude Code style */}
                {toolExecutions.length > 0 && (
                  <div className="space-y-0.5">
                    {toolExecutions.map((exec, i) => (
                      <ToolExecutionItem key={i} execution={exec} stepNumber={i + 1} />
                    ))}
                  </div>
                )}
                {/* Show streaming content or thinking/working indicator */}
                {streamingContent ? (
                  <MessageBubble
                    message={{ role: "assistant", content: streamingContent }}
                    isStreaming
                  />
                ) : (
                  <ThinkingIndicator isWorking={toolExecutions.length > 0} />
                )}
              </>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollArea>

      {/* Composer - Fixed at bottom with gradient fade */}
      <div
        className="sticky bottom-0 z-10 shrink-0 p-3 pt-8"
        style={{
          background: 'linear-gradient(to top, var(--background) 70%, transparent 100%)'
        }}
      >
        {/* Context items */}
        {contextItems.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {contextItems.map((item, i) => (
              <div
                key={i}
                className="flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs"
              >
                <span className="truncate max-w-[150px]">{item.path}</span>
                <button
                  onClick={() => removeContextItem(i)}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <InputGroup className="h-auto">
          <InputGroupTextarea
            ref={textareaRef}
            placeholder="Message Codea..."
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              // Auto-resize
              e.target.style.height = "auto"
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px"
            }}
            onKeyDown={handleKeyDown}
            className="min-h-[36px] max-h-[200px]"
            rows={1}
          />
          <InputGroupAddon align="block-end" className="justify-between">
            <div className="flex items-center gap-1">
              {/* Mode selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                    <HugeiconsIcon
                      icon={currentModeConfig?.icon || SparklesIcon}
                      strokeWidth={2}
                      className={cn(
                        "size-3.5",
                        currentMode === "ask" && "text-primary",
                        currentMode === "edit" && "text-green-500",
                        currentMode === "plan" && "text-blue-500",
                        currentMode === "yolo" && "text-destructive"
                      )}
                    />
                    <span>{currentModeConfig?.label.split(" ")[0]}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuRadioGroup value={currentMode} onValueChange={setCurrentMode}>
                    {permissionModes.map((mode) => (
                      <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                        <Item size="xs" className="p-0">
                          <HugeiconsIcon
                            icon={mode.icon}
                            strokeWidth={2}
                            className={cn(
                              "size-4",
                              mode.id === "ask" && "text-primary",
                              mode.id === "edit" && "text-green-500",
                              mode.id === "plan" && "text-blue-500",
                              mode.id === "yolo" && "text-destructive"
                            )}
                          />
                          <ItemContent>
                            <ItemTitle>{mode.label}</ItemTitle>
                            <ItemDescription className="text-xs">{mode.description}</ItemDescription>
                          </ItemContent>
                        </Item>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* File attachment */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    className="size-7"
                    onClick={() => vscode?.postMessage({ type: "addContext" })}
                  >
                    <HugeiconsIcon icon={AttachmentIcon} strokeWidth={2} className="size-4" />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>Add context (@)</TooltipContent>
              </Tooltip>
            </div>

            {/* Send/Stop button */}
            {isGenerating ? (
              <Button size="icon" variant="destructive" className="size-7 rounded-full" onClick={stopGeneration}>
                <HugeiconsIcon icon={StopIcon} strokeWidth={2} className="size-4" />
              </Button>
            ) : (
              <Button size="icon" className="size-7 rounded-full" onClick={sendMessage} disabled={!input.trim()}>
                <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} className="size-4" />
              </Button>
            )}
          </InputGroupAddon>
        </InputGroup>
        <div className="mt-2 text-center text-[10px] text-muted-foreground">
          Powered by <a href="https://alia.onl" target="_blank" rel="noopener noreferrer" className="hover:underline">Alia</a>, an <a href="https://oxy.so" target="_blank" rel="noopener noreferrer" className="hover:underline">Oxy</a> AI.
        </div>
      </div>
    </div>
  )
}

function ToolExecutionItem({ execution }: { execution: ToolExecution; stepNumber?: number }) {
  // Auto-expand bash commands by default
  const [isExpanded, setIsExpanded] = React.useState(execution.tool === 'run_command')
  const label = toolLabels[execution.tool] || execution.tool

  // Format description based on tool type
  const getDescription = () => {
    switch (execution.tool) {
      case 'read_file':
        return execution.args.path ? String(execution.args.path) : ''
      case 'write_file':
        return execution.args.path ? String(execution.args.path) : ''
      case 'edit_file':
        return execution.args.path ? String(execution.args.path) : ''
      case 'delete_file':
        return execution.args.path ? String(execution.args.path) : ''
      case 'list_files':
        return String(execution.args.path || '.')
      case 'search_files':
        return `"${execution.args.query || execution.args.pattern}" ${execution.args.path ? `in ${execution.args.path}` : ''}`
      case 'run_command':
        // Try to extract a description from the command
        const cmd = String(execution.args.command || '')
        if (cmd.includes('npm run build')) return 'Build the project'
        if (cmd.includes('npm test')) return 'Run tests'
        if (cmd.includes('npm install')) return 'Install dependencies'
        if (cmd.includes('git status')) return 'Check git status'
        if (cmd.includes('git diff')) return 'Show git diff'
        if (cmd.includes('git add')) return 'Stage changes'
        if (cmd.includes('git commit')) return 'Commit changes'
        if (cmd.includes('ls ')) return 'List directory'
        return ''
      case 'set_mode':
        return `→ ${execution.args.mode}`
      default:
        return ''
    }
  }

  const description = getDescription()
  const isCommand = execution.tool === 'run_command'
  const hasExpandableContent = isCommand || (execution.result && execution.status !== 'running' && execution.status !== 'preparing')

  return (
    <div className="py-1.5">
      {/* Main row with bullet, tool name, and description */}
      <div
        className={cn(
          "flex items-start gap-2 text-sm",
          hasExpandableContent && "cursor-pointer hover:opacity-80"
        )}
        onClick={() => hasExpandableContent && setIsExpanded(!isExpanded)}
      >
        {/* Bullet indicator */}
        <span className={cn(
          "mt-0.5 text-base leading-none",
          execution.status === "preparing" && "text-muted-foreground animate-pulse",
          execution.status === "running" && "text-yellow-500 animate-pulse",
          execution.status === "success" && "text-green-500",
          execution.status === "error" && "text-destructive"
        )}>
          ●
        </span>

        {/* Tool name and description */}
        <div className="flex-1 min-w-0">
          <span className="font-bold">{label}</span>
          {description && (
            <span className="text-muted-foreground ml-2">{description}</span>
          )}
          {hasExpandableContent && (
            <span className="text-muted-foreground ml-1 text-xs">
              {isExpanded ? '˅' : '˃'}
            </span>
          )}
        </div>
      </div>

      {/* Expanded content for commands - Claude Code style box */}
      {isExpanded && isCommand && (
        <div className="ml-5 mt-2 rounded-lg bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] overflow-hidden text-xs font-mono">
          <div className="flex border-b border-[var(--vscode-panel-border)]">
            <span className="text-muted-foreground px-3 py-2 w-12 shrink-0 border-r border-[var(--vscode-panel-border)] bg-muted/20">IN</span>
            <div className="px-3 py-2 flex-1 overflow-x-auto">
              <code className="text-foreground whitespace-pre">{String(execution.args.command || '')}</code>
            </div>
          </div>
          {execution.result && (
            <div className="flex">
              <span className="text-muted-foreground px-3 py-2 w-12 shrink-0 border-r border-[var(--vscode-panel-border)] bg-muted/20">OUT</span>
              <div className="px-3 py-2 flex-1 max-h-40 overflow-auto">
                <pre className="text-muted-foreground whitespace-pre-wrap">{execution.result}</pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Expanded content for other tools with results */}
      {isExpanded && !isCommand && execution.result && execution.status !== 'running' && (
        <div className="ml-5 mt-2 rounded-lg bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] p-3 text-xs font-mono max-h-40 overflow-auto">
          <pre className="text-muted-foreground whitespace-pre-wrap">{execution.result}</pre>
        </div>
      )}

      {/* Error display */}
      {execution.status === "error" && execution.result && !isExpanded && (
        <div className="ml-5 mt-1 text-xs text-destructive/80">
          {execution.result.slice(0, 100)}{execution.result.length > 100 ? '...' : ''}
        </div>
      )}
    </div>
  )
}

function WelcomeScreen({ userName, onSuggestionClick }: { userName: string | null; onSuggestionClick: (text: string) => void }) {
  const suggestions = [
    { text: "Explain this code", icon: SparklesIcon },
    { text: "Help me fix a bug", icon: AlertCircleIcon },
    { text: "Write a function that ", icon: NoteIcon },
  ]

  // Pick a random greeting (stable per render)
  const [greeting] = React.useState(() => greetings[Math.floor(Math.random() * greetings.length)])

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex flex-col items-center gap-4">
        <img src={LOGO_URI} alt="Codea" className="size-16 rounded-full" />
        <div>
          <h2 className="text-lg font-semibold">
            {userName ? `Hi ${userName}, ${greeting}` : `Hey, ${greeting}`}
          </h2>
          <p className="text-sm text-muted-foreground">
            {userName
              ? "I'm your AI coding assistant. Ask questions, get help with code, or explore ideas."
              : "Your AI coding assistant. Ask questions, get help with code, or explore ideas."}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <Button
            key={s.text}
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => onSuggestionClick(s.text)}
          >
            <HugeiconsIcon icon={s.icon} strokeWidth={2} className="size-4 text-primary" />
            {s.text.replace(" that ", "")}
          </Button>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {/* Context chips */}
        {message.context && message.context.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1 max-w-[85%]">
            {message.context.map((ctx, i) => (
              <div
                key={i}
                className="flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground"
              >
                <span className="truncate max-w-[120px]">{ctx.path}</span>
              </div>
            ))}
          </div>
        )}
        {/* Message bubble */}
        <div className="max-w-[85%] rounded-2xl bg-muted px-3 py-2 text-sm">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <img
        src={LOGO_URI}
        alt="Codea"
        className={cn("size-6 shrink-0 rounded-full", isStreaming && !message.content && "animate-pulse")}
      />
      <div className="flex-1 min-w-0 text-sm overflow-hidden">
        {isStreaming && !message.content ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>Thinking...</span>
          </div>
        ) : (
          <div className="markdown-content overflow-x-auto">
            <Markdown>{message.content}</Markdown>
          </div>
        )}
      </div>
    </div>
  )
}

export default Chat
