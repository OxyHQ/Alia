import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { Conversation } from '@/lib/models/conversation';

export async function GET() {
  try {
    await connectDB();
    // Obtener las últimas 20 conversaciones, ordenadas por actualización
    const conversations = await Conversation.find()
      .select('title updatedAt createdAt') // Solo campos necesarios para lista
      .sort({ updatedAt: -1 })
      .limit(20);
      
    return Response.json(conversations);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const body = await req.json();
    
    // Si viene con mensaje inicial
    const initialMessages = body.messages || [];
    const title = body.title || (initialMessages.length > 0 ? initialMessages[0].content.slice(0, 30) : 'Nueva Conversación');

    const conversation = await Conversation.create({
      title,
      messages: initialMessages
    });

    return Response.json(conversation);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
