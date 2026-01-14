import { NextRequest } from 'next/server'
import { getAllKeys, addKey, deleteKey, getKeyUsage } from '@/lib/load-balancer'

export async function GET() {
  const keys = getAllKeys()
  const keysWithUsage = keys.map(k => {
    const usage = getKeyUsage(k.key)
    return {
      ...k,
      keyMasked: k.key.slice(0, 4) + '...' + k.key.slice(-4),
      usage: usage ? {
        rpm: usage.requestsMinute,
        rpd: usage.requestsDay,
        tpm: usage.tokensMinute,
        tpd: usage.tokensDay
      } : null
    }
  })
  
  return Response.json(keysWithUsage)
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // Validar body
    if (!body.provider || !body.key || !body.modelId) {
      return Response.json({ error: 'Faltan campos requeridos' }, { status: 400 })
    }

    const newKey = addKey({
      provider: body.provider,
      key: body.key,
      modelId: body.modelId,
      rpm: body.rpm ? Number(body.rpm) : undefined,
      rpd: body.rpd ? Number(body.rpd) : undefined,
      isPaid: body.isPaid
    })
    
    return Response.json(newKey)
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { key } = await req.json()
    if (!key) return Response.json({ error: 'Key requerida' }, { status: 400 })
    
    deleteKey(key)
    return Response.json({ success: true })
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 })
  }
}
