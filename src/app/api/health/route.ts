import { NextResponse } from 'next/server';
import { connectDB, isConnected } from '@/lib/db';

export async function GET() {
  try {
    await connectDB();
    const connected = isConnected();
    return NextResponse.json({ 
      status: 'ok', 
      mongodb: connected ? 'connected' : 'disconnected',
      time: new Date().toISOString() 
    });
  } catch (error: any) {
    return NextResponse.json({ 
      status: 'error', 
      mongodb: 'error',
      message: error.message 
    }, { status: 500 });
  }
}
