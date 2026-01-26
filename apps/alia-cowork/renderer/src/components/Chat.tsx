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
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowUp02Icon,
  ArrowDown01Icon,
  Settings01Icon,
  SparklesIcon,
  CheckmarkCircle02Icon,
  NoteIcon,
  AlertCircleIcon,
  StopIcon,
} from "@hugeicons/core-free-icons"

// Electron API type
declare global {
  interface Window {
    api: {
      minimize: () => void
      maximize: () => void
      close: () => void
      toggleAlwaysOnTop: () => Promise<boolean>
      sendMessage: (message: string, mode: string, model: string, context?: any[]) => Promise<void>
      stopGeneration: () => void
      clearChat: () => void
      getUserInfo: () => Promise<any>
      getModels: () => Promise<any[]>
      captureScreen: () => Promise<string | null>
      onChatStart: (callback: () => void) => () => void
      onChatStream: (callback: (data: { content: string }) => void) => () => void
      onChatEnd: (callback: () => void) => () => void
      onChatError: (callback: (data: { message: string }) => void) => () => void
      onChatTool: (callback: (data: { tool: string; args: any; status: string }) => void) => () => void
      onChatToolResult: (callback: (data: { tool: string; success: boolean; result: string }) => void) => () => void
      onModeChanged: (callback: (data: { mode: string }) => void) => () => void
    }
  }
}

// Types
interface Message {
  role: "user" | "assistant"
  content: string
  context?: ContextItem[]
}

interface ToolExecution {
  tool: string
  args: Record<string, unknown>
  status: "preparing" | "running" | "success" | "error"
  result?: string
}

interface Model {
  id: string
  name: string
  description: string
}

interface ContextItem {
  path: string
  content: string
  language: string
}

// Permission modes
const permissionModes = [
  { id: "ask", label: "Ask before edits", description: "Asks for approval before making changes", icon: SparklesIcon },
  { id: "edit", label: "Edit automatically", description: "Makes changes without asking", icon: CheckmarkCircle02Icon },
  { id: "plan", label: "Plan mode", description: "Plans changes before executing", icon: NoteIcon },
  { id: "yolo", label: "Bypass permissions", description: "Full autonomous mode", icon: AlertCircleIcon },
]

// Greetings
const greetings = [
  "let's get started",
  "how can I help?",
  "ready to assist",
  "what shall we do?",
  "let's be productive",
]

// Tool labels
const toolLabels: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  delete_file: "Delete",
  list_files: "List",
  search_files: "Search",
  run_command: "Bash",
  open_application: "Open App",
  open_url: "Open URL",
  clipboard_read: "Read Clipboard",
  clipboard_write: "Write Clipboard",
  get_system_info: "System Info",
  screenshot: "Screenshot",
  set_mode: "Mode",
}

// Default models
const defaultModels: Model[] = [
  { id: "alia-v1-codea", name: "Cowork", description: "Fast assistant" },
  { id: "alia-v1-pro", name: "Cowork Pro", description: "Advanced reasoning" },
]

// Thinking phrases
const thinkingPhrases = ["Thinking...", "Pondering...", "Processing...", "Analyzing..."]
const workingPhrases = ["Working...", "Executing...", "Running...", "Building..."]

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

    const typeInterval = setInterval(() => {
      if (charIndex < phrase.length) {
        setDisplayText(phrase.slice(0, charIndex + 1))
        charIndex++
      } else {
        clearInterval(typeInterval)
        setIsTyping(false)
        setTimeout(() => setPhraseIndex((prev) => (prev + 1) % phrases.length), 1500)
      }
    }, 40)

    return () => clearInterval(typeInterval)
  }, [phraseIndex, phrases])

  return (
    <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
      <span className="animate-spin">✱</span>
      <span>{displayText}{isTyping && <span className="animate-pulse">|</span>}</span>
    </div>
  )
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
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const streamingContentRef = React.useRef("")

  React.useEffect(() => {
    streamingContentRef.current = streamingContent
  }, [streamingContent])

  // Initialize and set up listeners
  React.useEffect(() => {
    // Get user info
    window.api.getUserInfo().then((user) => {
      if (user) {
        setUserName(user.name?.first || user.username || null)
      }
    })

    // Get models
    window.api.getModels().then((data) => {
      if (data && data.length > 0) {
        setModels(data)
      }
    })

    // Chat event listeners
    const unsubStart = window.api.onChatStart(() => {
      setIsGenerating(true)
      setStreamingContent("")
      streamingContentRef.current = ""
      setToolExecutions([])
    })

    const unsubStream = window.api.onChatStream((data) => {
      setStreamingContent((prev) => prev + data.content)
    })

    const unsubEnd = window.api.onChatEnd(() => {
      setIsGenerating(false)
      const finalContent = streamingContentRef.current
      if (finalContent) {
        setMessages((prev) => [...prev, { role: "assistant", content: finalContent }])
      }
      setStreamingContent("")
      streamingContentRef.current = ""
      setToolExecutions([])
    })

    const unsubError = window.api.onChatError((data) => {
      setIsGenerating(false)
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.message}` }])
      setStreamingContent("")
      setToolExecutions([])
    })

    const unsubTool = window.api.onChatTool((data) => {
      setToolExecutions((prev) => {
        const existingIndex = prev.findIndex(t => t.tool === data.tool && t.status === "preparing")
        if (existingIndex >= 0 && data.status === "running") {
          return prev.map((t, i) => i === existingIndex ? { ...t, args: data.args, status: "running" } : t)
        }
        return [...prev, { tool: data.tool, args: data.args, status: data.status as any }]
      })
    })

    const unsubToolResult = window.api.onChatToolResult((data) => {
      setToolExecutions((prev) =>
        prev.map((t, i) => i === prev.length - 1 ? { ...t, status: data.success ? "success" : "error", result: data.result } : t)
      )
    })

    const unsubMode = window.api.onModeChanged((data) => {
      setCurrentMode(data.mode)
    })

    return () => {
      unsubStart()
      unsubStream()
      unsubEnd()
      unsubError()
      unsubTool()
      unsubToolResult()
      unsubMode()
    }
  }, [])

  // Auto-scroll
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingContent, toolExecutions])

  const sendMessage = () => {
    if (!input.trim() || isGenerating) return
    setMessages((prev) => [...prev, { role: "user", content: input.trim() }])
    window.api.sendMessage(input.trim(), currentMode, currentModel)
    setInput("")
  }

  const stopGeneration = () => {
    window.api.stopGeneration()
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
  const greeting = React.useMemo(() => greetings[Math.floor(Math.random() * greetings.length)], [])

  return (
    <div className="flex h-full flex-col">
      {/* Model Selector */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 px-2 h-7">
              <span className="text-sm font-medium">{models.find(m => m.id === currentModel)?.name || "Cowork"}</span>
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

        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 px-2 h-7">
                <HugeiconsIcon icon={currentModeConfig?.icon || SparklesIcon} strokeWidth={2} className={cn("size-3.5",
                  currentMode === "ask" && "text-primary",
                  currentMode === "edit" && "text-green-500",
                  currentMode === "yolo" && "text-destructive"
                )} />
                <span>{currentModeConfig?.label.split(" ")[0]}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuRadioGroup value={currentMode} onValueChange={setCurrentMode}>
                {permissionModes.map((mode) => (
                  <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                    <Item size="xs" className="p-0">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7">
                <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        {messages.length === 0 && !isGenerating ? (
          <WelcomeScreen userName={userName} greeting={greeting} onSuggestionClick={(text) => setInput(text)} />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {isGenerating && (
              <>
                {toolExecutions.length > 0 && (
                  <div className="space-y-0.5">
                    {toolExecutions.map((exec, i) => (
                      <ToolExecutionItem key={i} execution={exec} />
                    ))}
                  </div>
                )}
                {streamingContent ? (
                  <MessageBubble message={{ role: "assistant", content: streamingContent }} isStreaming />
                ) : (
                  <ThinkingIndicator isWorking={toolExecutions.length > 0} />
                )}
              </>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollArea>

      {/* Composer */}
      <div className="shrink-0 p-3 pt-2 border-t">
        <InputGroup>
          <InputGroupTextarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything or describe a task..."
            className="min-h-[60px] max-h-[200px] resize-none"
            autoFocus
          />
          <InputGroupButton position="bottom-end" className="mr-1 mb-1">
            {isGenerating ? (
              <Button size="icon" variant="destructive" className="size-7 rounded-full" onClick={stopGeneration}>
                <HugeiconsIcon icon={StopIcon} strokeWidth={2} className="size-4" />
              </Button>
            ) : (
              <Button size="icon" className="size-7 rounded-full" onClick={sendMessage} disabled={!input.trim()}>
                <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} className="size-4" />
              </Button>
            )}
          </InputGroupButton>
        </InputGroup>
        <div className="mt-2 text-center text-[10px] text-muted-foreground">
          Powered by <a href="https://alia.onl" target="_blank" rel="noopener noreferrer" className="hover:underline">Alia</a>
        </div>
      </div>
    </div>
  )
}

// Tool execution item
function ToolExecutionItem({ execution }: { execution: ToolExecution }) {
  const [isExpanded, setIsExpanded] = React.useState(execution.tool === 'run_command')
  const label = toolLabels[execution.tool] || execution.tool

  const getDescription = () => {
    switch (execution.tool) {
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        return String(execution.args.path || '')
      case 'run_command':
        const cmd = String(execution.args.command || '')
        if (cmd.includes('npm run build')) return 'Build the project'
        if (cmd.includes('npm test')) return 'Run tests'
        return ''
      case 'open_url':
        return String(execution.args.url || '')
      case 'open_application':
        return String(execution.args.path || '')
      default:
        return ''
    }
  }

  const description = getDescription()
  const isCommand = execution.tool === 'run_command'
  const hasExpandable = isCommand || (execution.result && execution.status !== 'running')

  return (
    <div className="py-1.5">
      <div
        className={cn("flex items-start gap-2 text-sm", hasExpandable && "cursor-pointer hover:opacity-80")}
        onClick={() => hasExpandable && setIsExpanded(!isExpanded)}
      >
        <span className={cn("mt-0.5 text-base leading-none",
          execution.status === "preparing" && "text-muted-foreground animate-pulse",
          execution.status === "running" && "text-yellow-500 animate-pulse",
          execution.status === "success" && "text-green-500",
          execution.status === "error" && "text-destructive"
        )}>●</span>
        <div className="flex-1 min-w-0">
          <span className="font-bold">{label}</span>
          {description && <span className="text-muted-foreground ml-2">{description}</span>}
          {hasExpandable && <span className="text-muted-foreground ml-1 text-xs">{isExpanded ? '˅' : '˃'}</span>}
        </div>
      </div>
      {isExpanded && isCommand && (
        <div className="ml-5 mt-2 rounded-lg bg-muted/30 border overflow-hidden text-xs font-mono">
          <div className="flex border-b">
            <span className="text-muted-foreground px-3 py-2 w-12 shrink-0 border-r bg-muted/20">IN</span>
            <div className="px-3 py-2 flex-1 overflow-x-auto">
              <code>{String(execution.args.command || '')}</code>
            </div>
          </div>
          {execution.result && (
            <div className="flex">
              <span className="text-muted-foreground px-3 py-2 w-12 shrink-0 border-r bg-muted/20">OUT</span>
              <div className="px-3 py-2 flex-1 max-h-40 overflow-auto">
                <pre className="text-muted-foreground whitespace-pre-wrap">{execution.result}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Message bubble
function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <img src="/alia-logo.png" alt="Alia" className={cn("size-6 shrink-0 rounded-full", isStreaming && !message.content && "animate-pulse")} />
      <div className="flex-1 min-w-0 overflow-hidden">
        {isStreaming && !message.content ? (
          <p className="text-sm text-muted-foreground">Thinking...</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none markdown-content">
            <Markdown>{message.content}</Markdown>
          </div>
        )}
      </div>
    </div>
  )
}

// Welcome screen
function WelcomeScreen({ userName, greeting, onSuggestionClick }: { userName: string | null; greeting: string; onSuggestionClick: (text: string) => void }) {
  const suggestions = [
    { title: "Open an app", description: "Open Visual Studio Code" },
    { title: "Run a command", description: "List files in my Documents folder" },
    { title: "System info", description: "Show my system information" },
    { title: "Take screenshot", description: "Capture my screen" },
  ]

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex flex-col items-center gap-4">
        <img src="/alia-logo.png" alt="Alia" className="size-16 rounded-full" />
        <div>
          <h2 className="text-lg font-semibold">
            {userName ? `Hi ${userName}, ${greeting}` : `Hey, ${greeting}`}
          </h2>
          <p className="text-sm text-muted-foreground">
            Your AI desktop assistant. I can control apps, run commands, and automate tasks.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
        {suggestions.map((item, i) => (
          <button
            key={i}
            onClick={() => onSuggestionClick(item.description)}
            className="flex flex-col items-start rounded-xl border p-3 text-left hover:bg-muted/50 transition-colors"
          >
            <span className="text-sm font-medium">{item.title}</span>
            <span className="text-xs text-muted-foreground line-clamp-1">{item.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
