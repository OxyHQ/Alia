/**
 * Model Resolver for Cowork
 *
 * Requests provider key and model info from Alia API, then creates AI SDK instances.
 * This keeps authentication and key management on the server while allowing
 * Cowork to use AI SDK directly without format conversion.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import * as https from 'https'
import * as http from 'http'

export interface ResolvedModel {
  model: any // AI SDK model instance
  provider: string
  modelId: string
  sessionId: string // For tracking usage
}

/**
 * Resolve model from Alia API and create AI SDK instance
 * Returns a ready-to-use AI SDK model with provider key
 */
export async function resolveModel(
  baseUrl: string,
  apiKey: string,
  aliaModelId: string
): Promise<ResolvedModel> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/v1/resolve-model`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    const postData = JSON.stringify({ model: aliaModelId, clientType: 'cowork' })

    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': `Bearer ${apiKey}`
        }
      },
      (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          if (res.statusCode !== 200) {
            try {
              const error = JSON.parse(data)
              reject(new Error(error.error || `HTTP ${res.statusCode}`))
            } catch {
              reject(new Error(`HTTP ${res.statusCode}`))
            }
            return
          }

          try {
            const parsed = JSON.parse(data)
            const model = createAIModel(parsed.provider, parsed.modelId, parsed.providerKey)

            resolve({
              model,
              provider: parsed.provider,
              modelId: parsed.modelId,
              sessionId: parsed.sessionId
            })
          } catch (error: any) {
            reject(new Error(`Failed to parse response: ${error.message}`))
          }
        })
      }
    )

    req.on('error', (error) => {
      reject(error)
    })

    req.write(postData)
    req.end()
  })
}

/**
 * Report usage back to Alia API for credit tracking
 */
export async function reportUsage(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/v1/report-usage`)
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    const postData = JSON.stringify({ sessionId, usage })

    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': `Bearer ${apiKey}`
        }
      },
      (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          // Ignore errors on usage reporting
          resolve()
        })
      }
    )

    req.on('error', () => {
      // Ignore errors on usage reporting
      resolve()
    })

    req.write(postData)
    req.end()
  })
}

/**
 * Create AI SDK model instance from provider config
 */
export function createAIModel(provider: string, modelId: string, apiKey: string): any {
  switch (provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey })
      return google(modelId)
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey })
      return openai(modelId)
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey })
      return anthropic(modelId)
    }
    case 'groq': {
      const groq = createOpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      })
      return groq(modelId)
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.ai/v1'
      })
      return together(modelId)
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1'
      })
      return cerebras(modelId)
    }
    default:
      throw new Error(`Provider "${provider}" not supported`)
  }
}
