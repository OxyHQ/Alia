import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { Conversation } from '@/lib/models/conversation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// Nota: En Next 15+, params es una Promise.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return Response.json({ error: 'No autorizado' }, { status: 401 });
    }

    await connectDB();
    const { id } = await Promise.resolve(params); 
    const userId = (session.user as any).id;
    
    // Validar ID mongo
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
        return Response.json({ error: 'ID inválido' }, { status: 400 });
    }

    const conversation = await Conversation.findOne({ _id: id, userId });
    
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
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return Response.json({ error: 'No autorizado' }, { status: 401 });
    }

    await connectDB();
    const { id } = await Promise.resolve(params);
    const userId = (session.user as any).id;
    const body = await req.json();

    const update: any = {};
    if (body.title) update.title = body.title;
    if (body.folderId !== undefined) update.folderId = body.folderId || null;
    if (body.icon !== undefined) update.icon = body.icon;
    if (body.iconColor !== undefined) update.iconColor = body.iconColor;
    if (body.isFavorite !== undefined) update.isFavorite = body.isFavorite;
    if (body.isPublic !== undefined) update.isPublic = body.isPublic;
    
    let conversation;

    if (body.newMessage) {
        const updateDoc: any = { 
            $push: { messages: body.newMessage },
            $set: { updatedAt: new Date() },
            ...update
        };

        // Si la IA sugiere un título y el usuario NO lo ha cambiado manualmente, lo actualizamos.
        if (body.suggestedTitle) {
            // Buscamos la conversación para ver si es manual
            const current = await Conversation.findOne({ _id: id, userId });
            if (current && !current.isManualTitle) {
                updateDoc.$set.title = body.suggestedTitle;
            }
        }

        conversation = await Conversation.findOneAndUpdate(
            { _id: id, userId }, 
            updateDoc,
            { new: true }
        );
    } else if (body.messageIndex !== undefined && body.vote) {
        const updateField = `messages.${body.messageIndex}.vote`;
        conversation = await Conversation.findOneAndUpdate(
            { _id: id, userId },
            { $set: { [updateField]: body.vote } },
            { new: true }
        );
    } else {
        conversation = await Conversation.findOneAndUpdate(
            { _id: id, userId }, 
            update, 
            { new: true }
        );
    }

    if (!conversation) {
        return Response.json({ error: 'Conversación no encontrada o no autorizada' }, { status: 404 });
    }

    return Response.json(conversation);
  } catch (e: any) {
     return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session || !session.user) {
          return Response.json({ error: 'No autorizado' }, { status: 401 });
        }

        await connectDB();
        const { id } = await Promise.resolve(params);
        const userId = (session.user as any).id;

        const result = await Conversation.findOneAndDelete({ _id: id, userId });
        
        if (!result) {
            return Response.json({ error: 'Conversación no encontrada o no autorizada' }, { status: 404 });
        }

        return Response.json({ success: true });
    } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
    }
}
