/**
 * MCP Local Client — Cowork
 *
 * Manages local MCP server processes on the user's machine and bridges
 * their tools to the Alia API via WebSocket. This enables local MCP
 * servers (filesystem, git, etc.) to be available in the chat pipeline.
 */

import { spawn, type ChildProcess } from 'child_process'
import Store from 'electron-store'

const store = new Store()

const JSON_RPC_TIMEOUT_MS = 15_000
const RECONNECT_DELAY_MS = 5_000
const MAX_STDOUT_BUFFER = 1024 * 1024 // 1 MiB

interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, any>
}

interface LocalServer {
  config: McpServerConfig
  process: ChildProcess
  tools: McpTool[]
  nextId: number
  pending: Map<number, {
    resolve: (value: any) => void
    reject: (reason: any) => void
    timer: NodeJS.Timeout
  }>
  buffer: string
}

export class McpLocalClient {
  private ws: WebSocket | null = null
  private servers = new Map<string, LocalServer>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  /**
   * Start the MCP client: fetch local servers, spawn them, and connect to relay.
   */
  async start(): Promise<void> {
    const apiKey = store.get('apiKey') as string
    if (!apiKey) return

    try {
      const configs = await this.fetchLocalServers(apiKey)
      if (!configs.length) return

      for (const config of configs) {
        await this.spawnServer(config)
      }

      this.connectRelay(apiKey)
    } catch (err) {
      console.error('[MCP] Failed to start:', err)
    }
  }

  private async fetchLocalServers(apiKey: string): Promise<McpServerConfig[]> {
    const baseUrl = (store.get('apiBaseUrl') as string) || 'https://api.alia.onl'
    const response = await fetch(`${baseUrl}/mcp/installed`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return []

    const data = (await response.json()) as any
    return (data.servers || [])
      .filter((s: any) => s.runtime === 'local' && s.enabled && s.config?.command)
      .map((s: any) => ({
        id: s._id,
        name: s.name,
        command: s.config.command,
        args: s.config.args || [],
        env: s.config.env,
      }))
  }

  private async spawnServer(config: McpServerConfig): Promise<void> {
    try {
      const proc = spawn(config.command, config.args, {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const server: LocalServer = {
        config,
        process: proc,
        tools: [],
        nextId: 0,
        pending: new Map(),
        buffer: '',
      }

      proc.stdout!.on('data', (chunk: Buffer) => {
        server.buffer += chunk.toString()
        if (server.buffer.length > MAX_STDOUT_BUFFER) {
          server.buffer = server.buffer.slice(-MAX_STDOUT_BUFFER)
        }
        this.processStdout(server)
      })

      proc.stderr!.on('data', (chunk: Buffer) => {
        console.warn(`[MCP:${config.name}] ${chunk.toString().trim()}`)
      })

      proc.on('exit', (code) => {
        console.log(`[MCP:${config.name}] exited (code ${code})`)
        this.servers.delete(config.id)
        this.sendMessage({ type: 'unregister-tools', serverId: config.id })
      })

      this.servers.set(config.id, server)

      await this.initializeServer(server)
      server.tools = await this.discoverTools(server)
      console.log(`[MCP:${config.name}] Started with ${server.tools.length} tools`)
    } catch (err) {
      console.error(`[MCP:${config.name}] Failed to spawn:`, err)
    }
  }

  private sendRpc(server: LocalServer, method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++server.nextId
      const timer = setTimeout(() => {
        server.pending.delete(id)
        reject(new Error(`JSON-RPC timeout: ${method}`))
      }, JSON_RPC_TIMEOUT_MS)

      server.pending.set(id, { resolve, reject, timer })

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'
      server.process.stdin!.write(msg)
    })
  }

  private processStdout(server: LocalServer): void {
    const lines = server.buffer.split('\n')
    server.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id === undefined) continue

        const pending = server.pending.get(msg.id)
        if (!pending) continue
        clearTimeout(pending.timer)
        server.pending.delete(msg.id)

        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'JSON-RPC error'))
        } else {
          pending.resolve(msg.result)
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  private async initializeServer(server: LocalServer): Promise<void> {
    await this.sendRpc(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'alia-cowork', version: '1.0.0' },
    })
    server.process.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    )
  }

  private async discoverTools(server: LocalServer): Promise<McpTool[]> {
    const result = await this.sendRpc(server, 'tools/list')
    return (result?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || t.name,
      inputSchema: t.inputSchema || {},
    }))
  }

  private connectRelay(apiKey: string): void {
    if (this.stopped) return

    const baseUrl = (store.get('apiBaseUrl') as string) || 'https://api.alia.onl'
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws/mcp'

    try {
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        console.log('[MCP] Relay connected')
        this.sendMessage({ type: 'auth', token: apiKey })
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string)
          this.handleRelayMessage(msg)
        } catch {}
      }

      this.ws.onclose = () => {
        if (this.stopped) return
        console.log('[MCP] Relay disconnected, reconnecting...')
        this.reconnectTimer = setTimeout(() => this.connectRelay(apiKey), RECONNECT_DELAY_MS)
      }

      this.ws.onerror = () => {
        // onclose will handle reconnection
      }
    } catch (err) {
      console.error('[MCP] Failed to connect relay:', err)
    }
  }

  private handleRelayMessage(msg: any): void {
    switch (msg.type) {
      case 'auth-ok':
        for (const server of this.servers.values()) {
          this.sendMessage({
            type: 'register-tools',
            serverId: server.config.id,
            serverName: server.config.name,
            tools: server.tools,
          })
        }
        break

      case 'auth-error':
        console.error('[MCP] Auth failed:', msg.error)
        this.ws?.close()
        break

      case 'tool-call':
        this.handleToolCall(msg).catch(console.error)
        break
    }
  }

  private async handleToolCall(msg: any): Promise<void> {
    const { callId, serverId, toolName, args } = msg
    const server = this.servers.get(serverId)

    if (!server) {
      this.sendMessage({ type: 'tool-error', callId, error: 'Server not found' })
      return
    }

    try {
      const result = await this.sendRpc(server, 'tools/call', {
        name: toolName,
        arguments: args || {},
      })

      // Extract text content from MCP response
      let text = ''
      if (Array.isArray(result?.content)) {
        text = result.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
      } else {
        text = JSON.stringify(result)
      }

      this.sendMessage({ type: 'tool-result', callId, result: text })
    } catch (err: any) {
      this.sendMessage({ type: 'tool-error', callId, error: err.message })
    }
  }

  private sendMessage(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

    for (const server of this.servers.values()) {
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Shutting down'))
      }
      server.process.kill('SIGTERM')
    }
    this.servers.clear()

    this.ws?.close()
    this.ws = null
  }
}
