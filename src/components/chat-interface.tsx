'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
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
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { RichMessage } from '@/components/rich-message'
import { useTranslations } from 'next-intl'

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
    const [input, setInput] = useState('')
    const t = useTranslations('chat')
    const tCommon = useTranslations('common')

    const getMessageText = useCallback((msg: any) => {
        if (typeof msg.content === 'string' && msg.content) return msg.content
        if (Array.isArray(msg.parts)) {
            return msg.parts
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join("")
        }
        return ""
    }, [])


    // removed useMemo to ensure updates are always caught and reference issues avoided
    const {
        messages,
        setMessages,
        sendMessage,
        stop,
        status,
        error
    } = useChat({
        transport: new DefaultChatTransport({
            api: '/api/alia/chat',
            body: { model: selectedModel },
        }),
        messages: initialMessages,

        onFinish: async ({ message }: { message: any }) => {
            const content = getMessageText(message)
            if (!isTemporary && conversationId) {
                await saveMessageToDB('assistant', content, conversationId);
            }
        },
        onError: (err: Error) => {
            console.error('❌ [useChat] Error:', err)
        }
    })

    const isLoading = status === 'submitted' || status === 'streaming'

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
                    body: JSON.stringify({ messages: [{ role, content }] })
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
                    body: JSON.stringify({ newMessage: { role, content } })
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

        try {
            if (overrideContent) {
                await sendMessage({ text: overrideContent })
            } else {
                const text = input
                setInput('') // Clear immediately for UX
                await sendMessage({ text })
            }

            if (!isTemporary) {
                const currentId = await saveMessageToDB('user', contentToSend, conversationId);
                if (!conversationId && currentId) setConversationId(currentId);
            }
        } catch (err) {
            console.error('🔥 [handleSubmit] Error:', err)
        }
    }

    return (
        <ChatContainerRoot className="bg-background">
            <ChatContainerContent ref={scrollRef} className="px-4 py-6 scroll-smooth">
                <div className="max-w-3xl mx-auto space-y-6">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-8 mt-4">
                            <div className="space-y-2">
                                <div className="relative flex h-16 w-16 items-center justify-center squircle overflow-hidden mb-4 shadow-sm mx-auto">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src="/icon-512-maskable.png" alt="Alia Logo" className="h-full w-full object-cover" />
                                </div>
                                <h1 className="text-3xl font-bold tracking-tight">{t('welcomeTitle')}</h1>
                                <h2 className="text-xl font-medium text-muted-foreground">{t('welcomeSubtitle')}</h2>
                                {isTemporary && (
                                    <div className="flex justify-center mt-2 animate-in fade-in zoom-in duration-300">
                                        <Badge variant="secondary" className="px-2">
                                            <Ghost data-icon="inline-start" className="size-3 fill-current" />
                                            {t('temporaryMode')}
                                        </Badge>
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl px-4">
                                {[
                                    { title: t('prompts.summarize.title'), text: t('prompts.summarize.text') },
                                    { title: t('prompts.email.title'), text: t('prompts.email.text') },
                                    { title: t('prompts.ideas.title'), text: t('prompts.ideas.text') },
                                    { title: t('prompts.code.title'), text: t('prompts.code.text') }
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

                    {messages.map((msg: any, i: number) => {
                        const isAssistant = msg.role === 'assistant'
                        const isLastMessage = i === messages.length - 1
                        const content = getMessageText(msg)

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
                                        <RichMessage
                                            content={content || (isLoading && isLastMessage ? '...' : '')}
                                            role="assistant"
                                            message={msg}
                                        />

                                        <MessageActions
                                            className={cn(
                                                "-ml-2.5 flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                                                isLastMessage && !isLoading && "opacity-100"
                                            )}
                                        >
                                            <MessageAction tooltip={tCommon('copy')} delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                    onClick={() => navigator.clipboard.writeText(content)}
                                                >
                                                    <Copy className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip={tCommon('upvote')} delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <ThumbsUp className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip={tCommon('downvote')} delayDuration={100}>
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
                                        <MessageContent className="bg-muted text-foreground max-w-[85%] rounded-2xl px-4 py-2 sm:max-w-[75%] break-words">
                                            {content}
                                        </MessageContent>
                                        <MessageActions
                                            className={cn(
                                                "flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                            )}
                                        >
                                            <MessageAction tooltip={tCommon('edit')} delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip={tCommon('delete')} delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                >
                                                    <Trash className="h-4 w-4" />
                                                </Button>
                                            </MessageAction>
                                            <MessageAction tooltip={tCommon('copy')} delayDuration={100}>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="rounded-full h-8 w-8 text-muted-foreground"
                                                    onClick={() => navigator.clipboard.writeText(content)}
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
                    {error && (
                        <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-sm border border-destructive/20">
                            <strong>{tCommon('error')}:</strong> {error.message}
                            <Button variant="link" size="sm" className="text-destructive font-bold ml-2 h-auto p-0" onClick={() => setMessages([])}>{t('resetChat')}</Button>
                        </div>
                    )}
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
                                placeholder={t('messagePlaceholder')}
                                className="min-h-[44px] text-base md:text-base py-3"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                            />
                            <div className="flex items-center justify-between gap-2 mt-2 mb-1">
                                <div className="flex items-center gap-1.5">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                                        type="button"
                                    >
                                        <Plus className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        className="h-8 rounded-full text-muted-foreground hover:text-foreground px-3 gap-2 font-normal text-xs"
                                        type="button"
                                    >
                                        <Globe className="h-4 w-4" />
                                        <span>{tCommon('search')}</span>
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
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
                                        <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); stop(); }}>
                                            <Square className="h-3 w-3 fill-current" />
                                        </div>
                                    ) : (
                                        <ArrowUp className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        </PromptInput>
                    </form>
                    <div className="text-center mt-2">
                        <p className="text-xs text-muted-foreground">{t('disclaimer')}</p>
                    </div>
                </div>
            </div>
        </ChatContainerRoot >
    )
}
