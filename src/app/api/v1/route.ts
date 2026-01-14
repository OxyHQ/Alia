import { NextResponse } from 'next/server'

/**
 * OpenAI-compatible API v1
 * 
 * This API is designed for external clients like Cursor, Continue, etc.
 * It follows the OpenAI API specification for compatibility.
 */
export async function GET() {
  return NextResponse.json({
    status: '🟢 Online',
    version: 'v1',
    description: 'OpenAI-compatible API for external clients',
    endpoints: {
      chat: 'POST /api/v1/chat/completions',
      models: 'GET /api/v1/models'
    },
    usage: {
      note: 'Configure your client to use this base URL',
      baseUrl: '/api/v1'
    }
  })
}
