import { ChatInterface } from '@/components/chat-interface'
import { connectDB } from '@/lib/db'
import { Conversation } from '@/lib/models/conversation'
import { notFound } from 'next/navigation'

export default async function ConversationPage({ params }: { params: { id: string } }) {
    const { id } = await Promise.resolve(params); // Next 15 compat

    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
        return notFound();
    }

    try {
        await connectDB();
        const conversation = await Conversation.findById(id).lean();

        if (!conversation) {
            return notFound();
        }

        // Serializar fechas y datos para Client Component
        const messages = (conversation.messages || []).map((m: any) => ({
            role: m.role,
            content: m.content
        }));

        return <ChatInterface id={id} initialMessages={messages} />
    } catch (e) {
        console.error(e);
        return notFound();
    }
}
