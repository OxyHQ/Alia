import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { Folder } from '@/lib/models/folder';
import { Conversation } from '@/lib/models/conversation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();
    const userId = (session.user as any).id;
    const { id } = await params;
    const body = await req.json();

    const folder = await Folder.findOne({ _id: id, userId });
    if (!folder) {
      return Response.json({ error: 'Folder not found' }, { status: 404 });
    }

    Object.assign(folder, body);
    await folder.save();

    return Response.json({ data: folder });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();
    const userId = (session.user as any).id;
    const { id } = await params;

    const folder = await Folder.findOneAndDelete({ _id: id, userId });
    if (!folder) {
      return Response.json({ error: 'Folder not found' }, { status: 404 });
    }

    // Unlink conversations
    await Conversation.updateMany(
      { folderId: id, userId },
      { $unset: { folderId: "" } }
    );

    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
