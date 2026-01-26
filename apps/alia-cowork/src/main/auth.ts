import { shell, BrowserWindow } from 'electron'
import Store from 'electron-store'
import * as http from 'http'
import * as https from 'https'

const store = new Store({
  defaults: {
    apiKey: '',
    apiBaseUrl: 'https://api.alia.onl',
    model: 'alia-v1-codea'
  }
})

export class AuthProvider {
  private mainWindow: BrowserWindow
  private callbackServer?: http.Server
  private authUrl = 'https://alia.onl/authorize/codea'

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /**
   * Start the OAuth flow
   */
  async startAuth(): Promise<void> {
    // Stop any existing callback server
    this.stopCallbackServer()

    // Start local callback server on random port
    const port = await this.startCallbackServer()

    // Build OAuth URL with callback
    const callbackUrl = `http://localhost:${port}/callback`
    const authUrlWithCallback = `${this.authUrl}?callback=${encodeURIComponent(callbackUrl)}`

    // Open browser to Alia authorization page
    shell.openExternal(authUrlWithCallback)
  }

  /**
   * Start local HTTP server to receive OAuth callback
   */
  private startCallbackServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer((req, res) => {
        const url = new URL(req.url || '', `http://localhost`)

        if (url.pathname === '/callback') {
          const token = url.searchParams.get('token')
          const error = url.searchParams.get('error')

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(`
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
            `)

            this.mainWindow.webContents.send('auth:error', { message: error })
            this.stopCallbackServer()
            return
          }

          if (token) {
            // Save token
            store.set('apiKey', token)

            // Send success response
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(`
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
            `)

            // Fetch user info and notify renderer
            this.fetchUserInfo(token).then((userInfo) => {
              this.mainWindow.webContents.send('auth:success', { token, userInfo })
            })

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
   * Fetch user info from API
   */
  private async fetchUserInfo(token: string): Promise<any> {
    const baseUrl = store.get('apiBaseUrl') as string

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
