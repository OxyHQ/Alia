import { shell, BrowserWindow } from 'electron'
import Store from 'electron-store'
import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'

// Default URLs (can be overridden via .env)
const DEFAULT_API_BASE_URL = 'https://api.alia.onl'
const DEFAULT_AUTH_URL = 'https://alia.onl/authorize/codea'

const store = new Store({
  defaults: {
    apiKey: '',
    apiBaseUrl: process.env.ALIA_API_URL || DEFAULT_API_BASE_URL,
    authUrl: process.env.ALIA_AUTH_URL || DEFAULT_AUTH_URL,
    model: 'alia-v1-codea'
  }
})

export class AuthProvider {
  private mainWindow: BrowserWindow
  private callbackServer?: http.Server
  private codeVerifier?: string

  private get authUrl(): string {
    // Environment variable takes precedence over stored value
    return process.env.ALIA_AUTH_URL || (store.get('authUrl') as string)
  }

  private get apiBaseUrl(): string {
    return process.env.ALIA_API_URL || (store.get('apiBaseUrl') as string)
  }

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /**
   * Generate a cryptographically random code verifier for PKCE
   */
  private generateCodeVerifier(): string {
    // Generate 32 random bytes and encode as base64url (43 characters)
    return crypto.randomBytes(32).toString('base64url')
  }

  /**
   * Generate code challenge from verifier using SHA256
   */
  private generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url')
  }

  /**
   * Start the OAuth flow with PKCE
   */
  async startAuth(): Promise<void> {
    // Stop any existing callback server
    this.stopCallbackServer()

    // Generate PKCE code verifier and challenge
    this.codeVerifier = this.generateCodeVerifier()
    const codeChallenge = this.generateCodeChallenge(this.codeVerifier)

    // Start local callback server on random port
    const port = await this.startCallbackServer()

    // Build OAuth URL with callback and PKCE challenge
    const callbackUrl = `http://localhost:${port}/callback`
    const authUrlWithCallback = `${this.authUrl}?callback=${encodeURIComponent(callbackUrl)}&code_challenge=${codeChallenge}&code_challenge_method=S256`

    // Open browser to Alia authorization page
    shell.openExternal(authUrlWithCallback)
  }

  /**
   * Start local HTTP server to receive OAuth callback
   */
  private startCallbackServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://localhost`)

        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(this.getErrorHtml(error))
            this.mainWindow.webContents.send('auth:error', { message: error })
            this.stopCallbackServer()
            return
          }

          if (code && this.codeVerifier) {
            // Exchange authorization code for token using PKCE
            try {
              const token = await this.exchangeCodeForToken(code, this.codeVerifier)

              // Save token
              store.set('apiKey', token)

              // Send success response
              res.writeHead(200, { 'Content-Type': 'text/html' })
              res.end(this.getSuccessHtml())

              // Fetch user info and notify renderer
              this.fetchUserInfo(token).then((userInfo) => {
                this.mainWindow.webContents.send('auth:success', { token, userInfo })
              })
            } catch (err: any) {
              res.writeHead(200, { 'Content-Type': 'text/html' })
              res.end(this.getErrorHtml(err.message || 'Token exchange failed'))
              this.mainWindow.webContents.send('auth:error', { message: err.message })
            }

            this.codeVerifier = undefined
            this.stopCallbackServer()
          }
        }
      })

      // Listen on random available port
      this.callbackServer.listen(0, 'localhost', () => {
        const address = this.callbackServer?.address()
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('Failed to start callback server'))
        }
      })

      this.callbackServer.on('error', reject)
    })
  }

  /**
   * Stop the callback server
   */
  private stopCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close()
      this.callbackServer = undefined
    }
  }

  /**
   * Exchange authorization code for token using PKCE
   */
  private exchangeCodeForToken(code: string, codeVerifier: string): Promise<string> {
    const baseUrl = this.apiBaseUrl

    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/auth/token`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const postData = JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: 'codea'
      })

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try {
              const response = JSON.parse(data)
              if (res.statusCode !== 200) {
                reject(new Error(response.error || `HTTP ${res.statusCode}`))
                return
              }
              if (!response.token) {
                reject(new Error('No token in response'))
                return
              }
              resolve(response.token)
            } catch {
              reject(new Error('Failed to parse token response'))
            }
          })
        }
      )

      req.on('error', reject)
      req.write(postData)
      req.end()
    })
  }

  /**
   * Get success HTML page
   */
  private getSuccessHtml(): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Successful</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 40px;
              background: white;
              border-radius: 12px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              max-width: 400px;
            }
            h1 { color: #27ae60; margin: 0 0 16px; }
            p { color: #666; margin: 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✓ Successfully Connected!</h1>
            <p>Your Alia account has been linked.</p>
            <p style="margin-top: 20px;">You can close this window and return to the app.</p>
          </div>
        </body>
      </html>
    `
  }

  /**
   * Get error HTML page
   */
  private getErrorHtml(error: string): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Failed</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 40px;
              background: white;
              border-radius: 12px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              max-width: 400px;
            }
            h1 { color: #e74c3c; margin: 0 0 16px; }
            p { color: #666; margin: 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Authorization Failed</h1>
            <p>${error}</p>
            <p style="margin-top: 20px;">You can close this window.</p>
          </div>
        </body>
      </html>
    `
  }

  /**
   * Fetch user info from API
   */
  private async fetchUserInfo(token: string): Promise<any> {
    const baseUrl = this.apiBaseUrl

    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/v1/codea/user`)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` }
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }

          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error('Failed to parse user info'))
            }
          })
        }
      )

      req.on('error', reject)
      req.end()
    })
  }

  /**
   * Sign out and clear stored token
   */
  signOut(): void {
    store.set('apiKey', '')
    this.mainWindow.webContents.send('auth:signedOut')
  }

  /**
   * Get current auth state
   */
  getAuthState(): { isAuthenticated: boolean; apiKey?: string } {
    const apiKey = store.get('apiKey') as string
    return {
      isAuthenticated: !!apiKey,
      apiKey: apiKey || undefined
    }
  }
}
