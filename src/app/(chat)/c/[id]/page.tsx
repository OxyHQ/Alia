import { ChatInterface } from '@/components/chat-interface'
import { connectDB } from '@/lib/db'
import { Conversation } from '@/lib/models/conversation'
import { notFound } from 'next/navigation'

export default async function ConversationPage({ params }: { params: { id: string } }) {
    const { id } = await Promise.resolve(params); // Next 15 compat

    let messages: { role: string; content: string }[] = [];

    // Only try to fetch from DB if it looks like a Mongo ID
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
        try {
            await connectDB();
            const conversation = await Conversation.findById(id).lean() as any;

            if (conversation) {
                messages = (conversation.messages || []).map((m: any) => ({
                    role: m.role,
                    content: m.content,
                    vote: m.vote
                }));
            }
        } catch (e) {
            console.error("Error fetching conversation from DB:", e);
        }
    }

    return <ChatInterface id={id} initialMessages={messages} />
}
