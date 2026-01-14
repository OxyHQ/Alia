'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
    Plus,
    Globe,
    MoreHorizontal,
    ArrowUp,
    Ghost,
    Copy,
    Pencil,
    ThumbsUp,
    ThumbsDown,
    Trash,
    Zap,
    Square
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { cn } from "@/lib/utils"
import {
    ChatContainerContent,
    ChatContainerRoot,
} from "@/components/prompt-kit/chat-container"
import {
    Message as UIMessage,
    MessageAction,
    MessageActions,
    MessageContent,
} from "@/components/prompt-kit/message"
import {
    PromptInput,
    PromptInputTextarea
} from '@/components/ui/prompt-input'
import { useChat } from 'ai/react'

interface ChatInterfaceProps {
    id?: string
    initialMessages?: any[]
}

export function ChatInterface({ id, initialMessages = [] }: ChatInterfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const router = useRouter()
    const [conversationId, setConversationId] = useState<string | undefined>(id)
    const [selectedModel, setSelectedModel] = useState("v1")
    const [isTemporary, setIsTemporary] = useState(false)

    const {
        messages,
        input,
        handleInputChange,
        handleSubmit: sdkSubmit,
        isLoading,
        stop,
        append,
        setMessages,
        setInput
    } = useChat({
        api: '/api/v1/chat/completions',
        initialMessages: initialMessages,
        body: {
            model: selectedModel
        },
        onFinish: async (message) => {
            if (!isTemporary && conversationId) {
                // Save assistant message to DB
                await saveMessageToDB('assistant', message.content, conversationId);
            }
        }
    })

    useEffect(() => {
        const savedModel = localStorage.getItem('alia-selected-model')
        if (savedModel) setSelectedModel(savedModel)

        const savedTemp = localStorage.getItem('alia-temporary-chat') === 'true'
        setIsTemporary(savedTemp)

        const handleModelChange = () => {
            const current = localStorage.getItem('alia-selected-model')
            if (current) setSelectedModel(current)
        }

        const handleTempChange = () => {
            const current = localStorage.getItem('alia-temporary-chat') === 'true'
            setIsTemporary(current)
        }

        window.addEventListener('alia-model-changed', handleModelChange)
        window.addEventListener('alia-temporary-chat-changed', handleTempChange)
        return () => {
            window.removeEventListener('alia-model-changed', handleModelChange)
            window.removeEventListener('alia-temporary-chat-changed', handleTempChange)
        }
    }, [])

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [messages])

    const saveMessageToDB = async (role: string, content: string, currentConvId?: string) => {
        if (!currentConvId && role === 'user') {
            try {
                const res = await fetch('/api/conversations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role, content }]
                    })
                })
                if (res.ok) {
                    const data = await res.json()
                    setConversationId(data._id)
                    window.history.replaceState(null, '', `/c/${data._id}`)
                    window.dispatchEvent(new Event('chat-updated'));
                    return data._id
                }
            } catch (e) {
                console.error("Error creating conversation", e)
            }
            return null
        } else if (currentConvId) {
            try {
                await fetch(`/api/conversations/${currentConvId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        newMessage: { role, content }
                    })
                })
                window.dispatchEvent(new Event('chat-updated'));
            } catch (e) {
                console.error("Error saving message", e)
            }
        }
        return currentConvId
    }

    const handleSubmit = async (e?: React.FormEvent, overrideContent?: string) => {
        if (e) e.preventDefault()

        const contentToSend = overrideContent || input
        if (!contentToSend.trim() || isLoading) return

        if (overrideContent) {
            append({ role: 'user', content: overrideContent })
        } else {
            sdkSubmit()
        }

        if (!isTemporary) {
            const currentId = await saveMessageToDB('user', contentToSend, conversationId);
            if (!conversationId && currentId) setConversationId(currentId);
        }
    }

    return (
        <ChatContainerRoot className="bg-background">
            <ChatContainerContent ref={scrollRef} className="px-4 py-6 scroll-smooth">
                <div className="max-w-3xl mx-auto space-y-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-8 mt-4">
                            <div className="space-y-2">
                                <div className="inline-flex p-4 rounded-full bg-primary/10 mb-2">
                                    <Zap className="w-8 h-8 text-primary" />
                                </div>
                                <h1 className="text-3xl font-bold tracking-tight">Alia</h1>
                                <h2 className="text-xl font-medium text-muted-foreground">¿En qué puedo ayudarte hoy?</h2>
                                {isTemporary && (
                                    <div className="flex justify-center mt-2 animate-in fade-in zoom-in duration-300">
                                        <Badge variant="secondary" className="px-2">
                                            <Ghost data-icon="inline-start" className="size-3 fill-current" />
                                            Modo Temporal
                                        </Badge>
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl px-4">
                                {[
                                    { title: "Resumir texto", text: "Resume este artículo en 3 puntos clave:" },
                                    { title: "Redactar correo", text: "Escribe un correo formal solicitando una reunión para..." },
                                    { title: "Explorar ideas", text: "Dame 5 ideas creativas para una campaña de marketing sobre..." },
                                    { title: "Código Python", text: "Escribe un script en Python para analizar un archivo CSV." }
                                ].map((prompt, i) => (
                                    <button
                                        key={i}
                                        onClick={() => handleSubmit(undefined, prompt.text)}
                                        className="flex flex-col items-start p-4 space-y-1 text-left transition-colors border rounded-xl hover:bg-muted/50 focus:bg-muted/50"
                                    >
                                        <span className="font-medium text-sm">{prompt.title}</span>
                                        <span className="text-muted-foreground text-xs line-clamp-1">{prompt.text}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {messages.map((msg, i) => {
                        const isAssistant = msg.role === 'assistant'
                        const isLastMessage = i === messages.length - 1

                        return (
                            <UIMessage
                                key={msg.id || i}
                                className={cn(
                                    "mx-auto flex w-full max-w-3xl flex-col gap-2 px-0",
                                    isAssistant ? "items-start" : "items-end"
                                )}
                            >
                                {isAssistant ? (
                                    <div className="group flex w-full flex-col gap-0">
                                        <MessageContent
                                            className="text-foreground prose dark:prose-invert w-full flex-1 rounded-lg bg-transparent p-0"
                                            markdown
                                        >
                                            {msg.content || '...'}
                                        </MessageContent>
                                        <MessageActions
                                            className={cn(
                                                "-ml-2.5 flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                                                isLastMessage && !isLoading && "opacity-100"
                                            )}
                                        >
                                            <MessageAction tooltip="Copy" delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                    onClick={() => navigator.clipboard.writeText(msg.content)}
                                                >
                                                    <Copy className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip="Upvote" delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <ThumbsUp className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip="Downvote" delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <ThumbsDown className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                        </MessageActions>
                                    </div>
                                ) : (
                                    <div className="group flex flex-col items-end gap-1">
                                        <MessageContent className="bg-muted text-foreground max-w-[85%] rounded-2xl px-4 py-2 sm:max-w-[75%]">
                                            {msg.content}
                                        </MessageContent>
                                        <MessageActions
                                            className={cn(
                                                "flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                            )}
                                        >
                                            <MessageAction tooltip="Edit" delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip="Delete" delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <Trash className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip="Copy" delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                    onClick={() => navigator.clipboard.writeText(msg.content)}
                                                >
                                                    <Copy className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                        </MessageActions>
                                    </div>
                                )}
                            </UIMessage>
                        )
                    })}
                </div>
            </ChatContainerContent>

            <div className="p-4 bg-background">
                <div className="max-w-3xl mx-auto">
                    <form onSubmit={handleSubmit}>
                        <PromptInput
                            value={input}
                            onValueChange={setInput}
                            onSubmit={() => handleSubmit()}
                            isLoading={isLoading}
                            className="rounded-3xl border shadow-[0_9px_9px_0px_rgba(0,0,0,0.01),0_2px_5px_0px_rgba(0,0,0,0.06)] px-3 py-1 bg-background"
                        >
                            <PromptInputTextarea
                                placeholder="Message Alia"
                                className="min-h-[44px] text-base md:text-base py-3"
                                value={input}
                                onChange={handleInputChange}
                            />
                            <div className="flex items-center justify-between gap-2 mt-2 mb-1">
                                <div className="flex items-center gap-1.5">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                                        aria-label="Attach files"
                                        type="button"
                                    >
                                        <Plus className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        className="h-8 rounded-full text-muted-foreground hover:text-foreground px-3 gap-2 font-normal text-xs"
                                        aria-label="Search the web"
                                        type="button"
                                    >
                                        <Globe className="h-4 w-4" />
                                        <span>Search</span>
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                                        aria-label="View tools"
                                        type="button"
                                    >
                                        <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                </div>

                                <Button
                                    size="icon"
                                    type="submit"
                                    disabled={!input.trim() && !isLoading}
                                    className="h-8 w-8 rounded-full"
                                >
                                    {isLoading ? (
                                        <Square className="h-3 w-3 fill-current" onClick={stop} />
                                    ) : (
                                        <ArrowUp className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        </PromptInput>
                    </form>
                    <div className="text-center mt-2">
                        <p className="text-xs text-muted-foreground">Alia can make mistakes. Check important info.</p>
                    </div>
                </div>
            </div>
        </ChatContainerRoot>
    )
}
