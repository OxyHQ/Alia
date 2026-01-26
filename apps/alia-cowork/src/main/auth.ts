import { shell, BrowserWindow } from 'electron'
import Store from 'electron-store'
import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'

// Default URLs (can be overridden via .env)
const DEFAULT_API_BASE_URL = 'https://api.alia.onl'
const DEFAULT_AUTH_URL = 'https://alia.onl/authorize/cowork'

const store = new Store({
  defaults: {
    apiKey: '',
    apiBaseUrl: process.env.ALIA_API_URL || DEFAULT_API_BASE_URL,
    authUrl: process.env.ALIA_AUTH_URL || DEFAULT_AUTH_URL,
    model: 'alia-v1-cowork'
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

              // Bring window to foreground
              if (!this.mainWindow.isVisible()) {
                this.mainWindow.show()
              }
              if (this.mainWindow.isMinimized()) {
                this.mainWindow.restore()
              }
              this.mainWindow.focus()
              this.mainWindow.moveTop()

              // Send success response
              res.writeHead(200, { 'Content-Type': 'text/html' })
              res.end(this.getSuccessHtml())

              // Fetch user info and notify renderer
              this.fetchUserInfo(token)
                .then((userInfo) => {
                  this.mainWindow.webContents.send('auth:success', { token, userInfo })
                })
                .catch((err) => {
                  console.error('Failed to fetch user info:', err)
                  // Still send success event even if user info fetch fails
                  this.mainWindow.webContents.send('auth:success', { token, userInfo: null })
                })
                .finally(() => {
                  // Delay server shutdown to ensure IPC event is sent
                  setTimeout(() => {
                    this.stopCallbackServer()
                  }, 1000)
                })
            } catch (err: any) {
              res.writeHead(200, { 'Content-Type': 'text/html' })
              res.end(this.getErrorHtml(err.message || 'Token exchange failed'))
              this.mainWindow.webContents.send('auth:error', { message: err.message })

              // Delay server shutdown to ensure IPC event is sent
              setTimeout(() => {
                this.stopCallbackServer()
              }, 1000)
            }

            this.codeVerifier = undefined
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
        client_id: 'cowork'
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
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              padding: 20px;
            }

            .container {
              text-align: center;
              padding: 48px 40px;
              background: white;
              border-radius: 24px;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
              max-width: 480px;
              width: 100%;
              animation: slideIn 0.4s ease-out;
            }

            @keyframes slideIn {
              from {
                opacity: 0;
                transform: translateY(-20px);
              }
              to {
                opacity: 1;
                transform: translateY(0);
              }
            }

            .logo-container {
              width: 80px;
              height: 80px;
              margin: 0 auto 24px;
              animation: scaleIn 0.5s ease-out 0.2s backwards;
            }

            @keyframes scaleIn {
              from {
                transform: scale(0);
              }
              to {
                transform: scale(1);
              }
            }

            .logo {
              width: 100%;
              height: 100%;
              border-radius: 16px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              display: flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 8px 16px rgba(102, 126, 234, 0.4);
            }

            .logo svg {
              width: 48px;
              height: 48px;
            }

            h1 {
              color: #1a1a1a;
              font-size: 28px;
              font-weight: 700;
              margin: 0 0 12px;
              letter-spacing: -0.5px;
            }

            .subtitle {
              color: #6b7280;
              font-size: 16px;
              margin: 0 0 8px;
              line-height: 1.5;
            }

            .instruction {
              color: #9ca3af;
              font-size: 14px;
              margin-top: 32px;
              padding-top: 24px;
              border-top: 1px solid #e5e7eb;
            }

            .brand {
              display: inline-block;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              background-clip: text;
              font-weight: 700;
            }

            .checkmark {
              color: white;
              font-size: 48px;
              font-weight: bold;
              line-height: 1;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo-container">
              <div class="logo">
                <span class="checkmark">✓</span>
              </div>
            </div>
            <h1>Successfully Connected!</h1>
            <p class="subtitle">Your <span class="brand">Alia</span> account has been linked to <span class="brand">Cowork</span></p>
            <p class="instruction">You can close this window and return to the app</p>
          </div>
        </body>
      </html>
    `
  }

  /**
   * Get error HTML page
   */
  private getErrorHtml(error: string): string {
    // Escape HTML to prevent XSS
    const escapedError = error.replace(/[<>'"]/g, (char) => {
      const entities: { [key: string]: string } = {
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }
      return entities[char]
    })

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Failed</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              padding: 20px;
            }

            .container {
              text-align: center;
              padding: 48px 40px;
              background: white;
              border-radius: 24px;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
              max-width: 480px;
              width: 100%;
              animation: slideIn 0.4s ease-out;
            }

            @keyframes slideIn {
              from {
                opacity: 0;
                transform: translateY(-20px);
              }
              to {
                opacity: 1;
                transform: translateY(0);
              }
            }

            .error-icon {
              width: 80px;
              height: 80px;
              margin: 0 auto 24px;
              background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              animation: scaleIn 0.5s ease-out 0.2s backwards;
            }

            @keyframes scaleIn {
              from {
                transform: scale(0);
              }
              to {
                transform: scale(1);
              }
            }

            .error-mark {
              color: white;
              font-size: 48px;
              font-weight: bold;
            }

            h1 {
              color: #1a1a1a;
              font-size: 28px;
              font-weight: 700;
              margin: 0 0 12px;
              letter-spacing: -0.5px;
            }

            .error-message {
              color: #6b7280;
              font-size: 16px;
              margin: 0 0 8px;
              line-height: 1.5;
              padding: 16px;
              background: #fef2f2;
              border-radius: 12px;
              border: 1px solid #fee2e2;
            }

            .instruction {
              color: #9ca3af;
              font-size: 14px;
              margin-top: 32px;
              padding-top: 24px;
              border-top: 1px solid #e5e7eb;
            }

            .brand {
              display: inline-block;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              background-clip: text;
              font-weight: 700;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error-icon">
              <span class="error-mark">✕</span>
            </div>
            <h1>Authorization Failed</h1>
            <p class="error-message">${escapedError}</p>
            <p class="instruction">You can close this window and try again from <span class="brand">Alia Cowork</span></p>
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
      const url = new URL(`${baseUrl}/v1/codea/me`)
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
