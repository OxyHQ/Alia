import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { Conversation } from '@/lib/models/conversation';

// Nota: En Next 15+, params es una Promise.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await Promise.resolve(params); // Next 15 safe compat
    
    // Validar ID mongo
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
        return Response.json({ error: 'ID inválido' }, { status: 400 });
    }

    const conversation = await Conversation.findById(id);
    
    if (!conversation) {
      return Response.json({ error: 'Conversación no encontrada' }, { status: 404 });
    }

    return Response.json(conversation);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await Promise.resolve(params);
    const body = await req.json();

    // Actualizar título, o añadir mensaje
    // Si viene 'messages', se reemplaza o hace push? 
    // Para simplificar, si viene 'newMessage', hacemos push. Si viene 'title', update title.
    
    const update: any = {};
    if (body.title) update.title = body.title;
    
    let conversation;

    if (body.newMessage) {
        conversation = await Conversation.findByIdAndUpdate(
            id, 
            { 
                $push: { messages: body.newMessage },
                $set: { updatedAt: new Date() }, // Forzar update de fecha
                ...update
            },
            { new: true }
        );
    } else {
        conversation = await Conversation.findByIdAndUpdate(id, update, { new: true });
    }

    if (!conversation) {
        return Response.json({ error: 'Conversación no encontrada' }, { status: 404 });
    }

    return Response.json(conversation);
  } catch (e: any) {
     return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await connectDB();
        const { id } = await Promise.resolve(params);
        await Conversation.findByIdAndDelete(id);
        return Response.json({ success: true });
    } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
    }
}
