import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import { Folder } from '@/lib/models/folder';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();
    const userId = (session.user as any).id;

    const folders = await Folder.find({ userId }).sort({ name: 1 });
    return Response.json({ data: folders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();
    const userId = (session.user as any).id;
    const body = await req.json();

    const { name, color, icon } = body;

    const folder = await Folder.create({
      name,
      userId,
      color,
      icon
    });

    return Response.json({ data: folder });
  } catch (e: any) {
    if (e.code === 11000) {
      return Response.json({ error: 'Folder name already exists' }, { status: 400 });
    }
    return Response.json({ error: e.message }, { status: 500 });
  }
}
