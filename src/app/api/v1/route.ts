import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    status: '🟢 Online',
    version: 'v1',
    description: 'Alia API Gateway',
    endpoints: {
      chat: '/api/v1/chat/completions'
    }
  })
}
