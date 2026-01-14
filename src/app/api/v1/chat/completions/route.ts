import { NextRequest } from 'next/server'
import { getBestAvailableKey, loadKeys } from '@/lib/load-balancer'
import { getProvider } from '@/lib/providers'

const keyPool = loadKeys()

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return Response.json({ error: 'Se requiere "messages"' }, { status: 400 })
    }

    const key = getBestAvailableKey(keyPool)
    if (!key) {
      return Response.json({ error: 'Todos los proveedores saturados' }, { status: 503 })
    }

    const provider = getProvider(key.provider)
    if (!provider) {
      return Response.json({ error: `Proveedor "${key.provider}" no implementado` }, { status: 400 })
    }

    const config = {
      temperature: body.temperature ?? 0.7,
      maxTokens: body.max_tokens || body.max_completion_tokens || 8192
    }

    const stream = await provider.proxy(key, body.messages, body.tools, config)

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    })
  } catch (e: unknown) {
    console.error('❌', e)
    const message = e instanceof Error ? e.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}

export async function GET() {
  const stats = {
    total: keyPool.length,
    free: keyPool.filter(k => !k.isPaid).length,
    paid: keyPool.filter(k => k.isPaid).length,
    providers: [...new Set(keyPool.map(k => k.provider))]
  }
  
  return Response.json({
    status: '🟢 Online',
    service: 'Alia AI Agent System',
    keys: stats,
    endpoint: '/api/v1/chat/completions'
  })
}
