import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { Conversation } from '@/lib/models/conversation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
      // Si no hay sesión, devolvemos array vacío. El frontend manejará localStorage.
      return Response.json([]);
    }

    await connectDB();
    const userId = (session.user as any).id;

    // Obtener conversaciones del usuario que tengan al menos un mensaje
    const conversations = await Conversation.find({ 
      userId,
      messages: { $not: { $size: 0 } }
    })
      .select('title updatedAt createdAt') 
      .sort({ updatedAt: -1 })
      .limit(20);
      
    return Response.json(conversations);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    // Si no hay sesión, no guardamos en DB.
    // Podríamos devolver un error o simplemente simular éxito sin guardar.
    // Para ser explícitos: devolvemos que se requiere auth para guardar en nube.
    if (!session || !session.user) {
        return Response.json({ message: 'Saved locally only' }, { status: 200 }); // O 401 si queremos forzar? Mejor 200 y que el front decida.
        // Pero espera, el prompt dice: "si el usuario no ha iniciado sesion las conversaciones solo se guardan en local".
        // Esto implica que el Backend NO debe guardar nada.
        // Asumo que el frontend intentará llamar a la API. Si la API responde que no hay usuario, el frontend debe saber que es local.
        // O mejor: el frontend detecta que no hay usuario y NO llama a la API.
        // Pero si la llama por error, protegemos aquí.
    }

    await connectDB();
    const userId = (session.user as any).id;
    const body = await req.json();
    
    // Si viene con mensaje inicial
    const initialMessages = body.messages || [];
    const title = body.suggestedTitle || body.title || (initialMessages.length > 0 ? initialMessages[0].content.slice(0, 30) : 'Nueva Conversación');

    const conversation = await Conversation.create({
      _id: body.id || undefined, // Permitir usar ID pre-asignado por el cliente
      title,
      messages: initialMessages,
      userId
    });

    return Response.json(conversation);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
