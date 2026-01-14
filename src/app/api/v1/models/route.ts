import { NextResponse } from 'next/server'
import { loadKeys } from '@/lib/load-balancer'

export async function GET() {
  const keys = loadKeys()
  
  // Create a list of models based on uniquely available modelIds in the keys
  const modelIds = Array.from(new Set(keys.map(k => k.modelId)))
  
  const models = modelIds.map(id => ({
    id: id,
    object: 'model',
    created: 1677610602, // Placeholder timestamp
    owned_by: 'alia-proxy'
  }))

  return NextResponse.json({
    object: 'list',
    data: models
  })
}
