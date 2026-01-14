import { NextResponse, NextRequest } from 'next/server'
import { getBestAvailableKey, loadKeys } from '@/lib/load-balancer'
import { getProvider } from '@/lib/providers'

const keyPool = loadKeys()

export async function POST(req: NextRequest) {
  try {
    console.log('📬 [API/POST] Request received')
    const body = await req.json()
    console.log('📦 [API/POST] Body:', JSON.stringify(body).slice(0, 100) + '...')
    
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return NextResponse.json({ error: 'Se requiere "messages"' }, { status: 400 })
    }

    const key = getBestAvailableKey(keyPool)
    if (!key) {
      return NextResponse.json({ error: 'Todos los proveedores saturados' }, { status: 503 })
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
    console.error('❌ [API/POST] Error:', e)
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET() {
  console.log('📡 [API/GET] Request received')
  const stats = {
    total: keyPool.length,
    free: keyPool.filter(k => !k.isPaid).length,
    paid: keyPool.filter(k => k.isPaid).length,
    providers: [...new Set(keyPool.map(k => k.provider))]
  }
  
  return NextResponse.json({
    status: '🟢 Online',
    service: 'Alia AI Agent System',
    keys: stats,
    endpoint: '/api/v1/chat/completions'
  })
}
