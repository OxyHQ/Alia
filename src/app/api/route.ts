import { NextResponse } from 'next/server'

/**
 * Alia API Root
 * 
 * This server provides two distinct API surfaces:
 * 
 * 1. /api/v1/* - OpenAI-compatible API for external clients (Cursor, etc.)
 *    - /api/v1/chat/completions - Chat completions endpoint
 *    - /api/v1/models - Available models list
 * 
 * 2. /api/alia/* - Internal API for Alia web application
 *    - /api/alia/chat - Chat endpoint using AI SDK
 */
export async function GET() {
  return NextResponse.json({
    status: '🟢 Online',
    service: 'Alia AI API Server',
    version: '1.0.0',
    apis: {
      v1: {
        description: 'OpenAI-compatible API for external clients',
        baseUrl: '/api/v1',
        endpoints: {
          chat: '/api/v1/chat/completions',
          models: '/api/v1/models'
        }
      },
      alia: {
        description: 'Internal API for Alia web application',
        baseUrl: '/api/alia',
        endpoints: {
          chat: '/api/alia/chat'
        }
      }
    },
    other: {
      conversations: '/api/conversations',
      admin: '/api/admin'
    }
  })
}
