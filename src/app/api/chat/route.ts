import { POST as v1POST, GET as v1GET } from '../v1/chat/completions/route'

export const GET = v1GET

export async function POST(req: Request) {
  // Call the standard OpenAI-compatible logic
  const response = await v1POST(req as any)
  
  if (!response.ok) {
    return response
  }

  const readable = response.body
  if (!readable) return response

  const reader = readable.getReader()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let buffer = ''
        
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.trim() === 'data: [DONE]') continue
            if (line.startsWith('data: ')) {
              try {
                const json = line.slice(6)
                const data = JSON.parse(json)
                const content = data.choices?.[0]?.delta?.content
                
                if (content) {
                  // Vercel AI SDK Data Protocol: 0:"<json_encoded_text>"\n
                  console.log('🔹 [API/Chat] Enqueueing chunk:', content.slice(0, 50))
                  controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`))
                }
                
                // We can also handle tools/reasoning here if needed later
                
              } catch (e) {
                // ignore parse errors or keep alive
              }
            }
          }
        }
      } catch (e) {
        controller.error(e)
      } finally {
        controller.close()
      }
    }
  })

  // Return generic text/plain for AI SDK
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1'
    }
  })
}
