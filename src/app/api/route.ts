import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    status: '🟢 Online',
    message: 'Welcome to Alia API Root',
    version: '1.0.0',
    documentation: 'https://docs.example.com',
    endpoints: {
      v1: '/api/v1',
      chat: '/api/chat (fallback)',
      conversations: '/api/conversations',
      admin: '/api/admin'
    }
  })
}
